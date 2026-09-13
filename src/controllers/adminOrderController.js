import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { Refund } from '../models/Refund.js'
import { restoreOrderInventory } from '../utils/inventory.js'
import { reconcileOrderPayment } from '../services/paymentReconciliationService.js'
import {
  initiateRefund,
  reconcileRefundRecord,
} from '../services/refundReconciliationService.js'
import { recordAuditLog } from '../services/auditLogger.js'
import { cancelOrder } from '../services/orderCancellationService.js'

const ORDER_STATUS_MAP = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PENDING: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  PROCESSING: 'PROCESSING',
  SHIPPED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  REQUIRES_RECONCILIATION: 'REQUIRES_RECONCILIATION',
}

const PAYMENT_STATUS_MAP = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  PAID: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
}

const ALLOWED_ORDER_TRANSITIONS = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REQUIRES_RECONCILIATION'],
  PROCESSING: ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  REQUIRES_RECONCILIATION: ['CANCELLED'],
}

function normalizeOrderStatus(val) {
  if (!val || typeof val !== 'string') return null
  const cleaned = val.trim().toUpperCase().replace(/\s+/g, '_')
  return ORDER_STATUS_MAP[cleaned] || null
}

function normalizePaymentStatus(val) {
  if (!val || typeof val !== 'string') return null
  const cleaned = val.trim().toUpperCase()
  return PAYMENT_STATUS_MAP[cleaned] || null
}

function validateTrackingUrl(raw) {
  let trimmed = String(raw || '').trim()
  if (!trimmed) return { valid: false, error: 'Tracking URL is required when marking an order as Shipped.' }
  if (trimmed.length > 2048) return { valid: false, error: 'Tracking URL must not exceed 2048 characters.' }

  // Auto-prefix protocol if missing (e.g. www.delhivery.com/track/123 or delhivery.com)
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^[a-z0-9+-.]+:/i.test(trimmed)) {
      return { valid: false, error: 'Only http:// and https:// URLs are allowed.' }
    }
    trimmed = `https://${trimmed}`
  }

  try {
    const parsed = new URL(trimmed)
    const SAFE = ['http:', 'https:']
    if (!SAFE.includes(parsed.protocol)) {
      return { valid: false, error: `Tracking URL protocol "${parsed.protocol}" is not allowed. Only http and https are permitted.` }
    }
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return { valid: false, error: 'Tracking URL must be a valid web domain address.' }
    }
  } catch {
    return { valid: false, error: 'Tracking URL is not a valid web URL.' }
  }
  return { valid: true, url: trimmed }
}

function escapeRegex(text) {
  return String(text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

export function formatAdminOrder(order) {
  const doc = order.toObject ? order.toObject() : order

  // Sanitize user object - strictly remove sensitive authentication credentials
  let safeUser = null
  if (doc.userId && typeof doc.userId === 'object') {
    safeUser = {
      id: String(doc.userId._id || doc.userId.id || ''),
      _id: String(doc.userId._id || doc.userId.id || ''),
      name: doc.userId.name || doc.customerName,
      email: doc.userId.email || doc.email,
      phone: doc.userId.phone || doc.phone,
      role: doc.userId.role,
      isActive: doc.userId.isActive,
    }
  } else if (doc.userId) {
    safeUser = {
      id: String(doc.userId),
      _id: String(doc.userId),
      name: doc.customerName,
      email: doc.email,
      phone: doc.phone,
    }
  }

  const statusTitleMap = {
    PENDING_PAYMENT: 'Pending',
    CONFIRMED: 'Confirmed',
    PROCESSING: 'Processing',
    SHIPPED: 'Shipped',
    OUT_FOR_DELIVERY: 'Out for Delivery',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    REQUIRES_RECONCILIATION: 'Pending',
  }

  const paymentTitleMap = {
    PENDING: 'Pending',
    SUCCESS: 'Paid',
    PAID: 'Paid',
    FAILED: 'Failed',
    REFUNDED: 'Refunded',
  }

  const canonicalPaymentStatus = doc.paymentStatus === 'SUCCESS' ? 'PAID' : doc.paymentStatus

  const items = (doc.items || []).map((item) => ({
    id: item.variantId || String(item.productId),
    productId: String(item.productId),
    variantId: item.variantId,
    name: item.productName,
    productName: item.productName,
    variantLabel: item.variantLabel,
    weight: item.weight || item.variantLabel || '',
    sku: item.sku,
    price: item.unitPrice,
    unitPrice: item.unitPrice,
    originalPrice: item.originalPrice ?? null,
    discount: item.discount ?? null,
    quantity: item.quantity,
    restoredQuantity: item.restoredQuantity || 0,
    lineTotal: item.lineTotal,
    image: item.image || '',
    storefront: item.storefront || '',
  }))

  const addressLines = doc.shippingAddress?.lines?.length
    ? doc.shippingAddress.lines
    : [
        doc.shippingAddress?.street,
        `${doc.shippingAddress?.city || ''}, ${doc.shippingAddress?.state || ''} - ${doc.shippingAddress?.pin || ''}`.trim().replace(/^,\s*|-\s*$/g, ''),
      ].filter(Boolean)

  const shippingAddress = doc.shippingAddress
    ? {
        name: doc.shippingAddress.name,
        phone: doc.shippingAddress.phone,
        street: doc.shippingAddress.street,
        city: doc.shippingAddress.city,
        state: doc.shippingAddress.state,
        pin: doc.shippingAddress.pin,
        country: doc.shippingAddress.country || 'India',
        lines: addressLines,
      }
    : null

  const history = (doc.history || []).map((h) => ({
    status: h.status,
    at: h.at,
    note: h.note || '',
    cancelledBy: h.cancelledBy || null,
  }))

  return {
    id: String(doc._id),
    _id: String(doc._id),
    orderNumber: doc.orderNumber,
    number: doc.orderNumber,
    user: safeUser,
    userId: safeUser,
    customer: safeUser || {
      id: String(doc.userId || ''),
      name: doc.customerName,
      email: doc.email,
      phone: doc.phone,
    },
    customerName: doc.customerName,
    email: doc.email,
    phone: doc.phone,
    shippingAddress,
    address: shippingAddress,
    items,
    subtotal: doc.subtotal,
    shippingFee: doc.shippingFee,
    shipping: doc.shippingFee,
    discount: doc.discount || 0,
    coupon: doc.coupon
      ? {
          code: doc.coupon.code,
          discountType: doc.coupon.discountType,
          discountValue: doc.coupon.discountValue,
          maxDiscount: doc.coupon.maxDiscount ?? null,
          discountAmount: doc.coupon.discountAmount,
          productScope: doc.coupon.productScope,
          customerEligibility: doc.coupon.customerEligibility,
        }
      : null,
    tax: 0,
    totalAmount: doc.totalAmount,
    total: doc.totalAmount,
    amount: doc.totalAmount,
    status: doc.status,
    displayStatus: statusTitleMap[doc.status] || doc.status,
    cancellationReason: (Array.isArray(doc.history) ? [...doc.history].reverse().find((h) => h.status === 'CANCELLED')?.note : null) || null,
    cancelledByRole: (Array.isArray(doc.history) ? [...doc.history].reverse().find((h) => h.status === 'CANCELLED')?.cancelledBy : null) || null,
    paymentStatus: canonicalPaymentStatus,
    rawPaymentStatus: doc.paymentStatus,
    displayPaymentStatus: paymentTitleMap[doc.paymentStatus] || doc.paymentStatus,
    paymentMethod: doc.paymentMethod || null,
    payment: doc.paymentMethod ? `Paid via ${doc.paymentMethod}` : 'Online Payment',
    paymentId: doc.paymentId || null,
    razorpayOrderId: doc.razorpayOrderId || null,
    courier: doc.courier || null,
    trackingNumber: doc.trackingNumber || null,
    trackingUrl: doc.trackingUrl || null,
    notes: doc.notes || '',
    expectedDeliveryDate:
      doc.expectedDeliveryDate ||
      (doc.createdAt
        ? new Date(new Date(doc.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000)
        : null),
    history,
    statusHistory: history,
    storefronts: Array.from(new Set(items.map((i) => i.storefront).filter(Boolean))),
    date: doc.createdAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

// 1. GET /api/admin/orders
export async function getAdminOrders(req, res, next) {
  try {
    const {
      page: rawPage,
      limit: rawLimit,
      search,
      status,
      paymentStatus,
      storefront,
      dateRange,
      dateFrom,
      dateTo,
      sort,
      couponCode,
    } = req.query

    const page = Math.max(1, parseInt(rawPage, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(rawLimit, 10) || 10))
    const skip = (page - 1) * limit

    const query = {}

    // Search filter across orderNumber, customerName, email, phone
    if (search && typeof search === 'string' && search.trim()) {
      const regex = new RegExp(escapeRegex(search.trim()), 'i')
      query.$or = [
        { orderNumber: regex },
        { customerName: regex },
        { email: regex },
        { phone: regex },
      ]
    }

    // Status filter
    if (status && status !== 'all') {
      const normalized = normalizeOrderStatus(status)
      if (normalized) {
        query.status = normalized
      }
    }

    // Payment status filter
    if (paymentStatus && paymentStatus !== 'all') {
      const normalized = normalizePaymentStatus(paymentStatus)
      if (normalized) {
        query.paymentStatus = normalized
      }
    }

    // Storefront filter
    if (storefront && storefront !== 'all') {
      query['items.storefront'] = storefront
    }

    // Coupon code filter
    if (couponCode && typeof couponCode === 'string' && couponCode.trim()) {
      query['coupon.code'] = String(couponCode).trim().toUpperCase()
    }

    // Date range filter
    if (dateRange && dateRange !== 'all') {
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (dateRange === '7d') {
        query.createdAt = { $gte: new Date(today.getTime() - 6 * 86400000) }
      } else if (dateRange === '30d') {
        query.createdAt = { $gte: new Date(today.getTime() - 29 * 86400000) }
      } else if (dateRange === 'month') {
        query.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
      } else if (dateRange === 'custom') {
        const dateQuery = {}
        if (dateFrom) dateQuery.$gte = new Date(`${dateFrom}T00:00:00.000Z`)
        if (dateTo) dateQuery.$lte = new Date(`${dateTo}T23:59:59.999Z`)
        if (Object.keys(dateQuery).length > 0) query.createdAt = dateQuery
      }
    } else if (dateFrom || dateTo) {
      const dateQuery = {}
      if (dateFrom) dateQuery.$gte = new Date(`${dateFrom}T00:00:00.000Z`)
      if (dateTo) dateQuery.$lte = new Date(`${dateTo}T23:59:59.999Z`)
      if (Object.keys(dateQuery).length > 0) query.createdAt = dateQuery
    }

    // Sort order
    let sortOption = { createdAt: -1 }
    if (sort === 'date_asc' || sort === 'oldest') {
      sortOption = { createdAt: 1 }
    } else if (sort === 'total_desc' || sort === 'amount_desc') {
      sortOption = { totalAmount: -1 }
    } else if (sort === 'total_asc' || sort === 'amount_asc') {
      sortOption = { totalAmount: 1 }
    }

    const [total, orders] = await Promise.all([
      Order.countDocuments(query),
      Order.find(query)
        .populate('userId', 'name email phone role isActive')
        .sort(sortOption)
        .skip(skip)
        .limit(limit),
    ])

    const totalPages = Math.ceil(total / limit) || 0

    res.json({
      success: true,
      orders: orders.map(formatAdminOrder),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    })
  } catch (err) {
    next(err)
  }
}

// 2. GET /api/admin/orders/:id
export async function getAdminOrderById(req, res, next) {
  try {
    const rawId = String(req.params.id || '').trim()

    let order = null
    if (mongoose.isValidObjectId(rawId)) {
      order = await Order.findById(rawId).populate('userId', 'name email phone role isActive')
    }

    if (!order) {
      const cleanNumber = rawId.startsWith('#') ? rawId : `#${rawId}`
      order = await Order.findOne({
        $or: [{ orderNumber: rawId }, { orderNumber: cleanNumber }],
      }).populate('userId', 'name email phone role isActive')
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'order_not_found',
          message: 'Order not found.',
        },
      })
    }

    res.json({
      success: true,
      order: formatAdminOrder(order),
    })
  } catch (err) {
    next(err)
  }
}

// 3. PATCH /api/admin/orders/:id
export async function updateAdminOrder(req, res, next) {
  try {
    const rawId = String(req.params.id || '').trim()

    if (!mongoose.isValidObjectId(rawId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_id',
          message: 'Invalid MongoDB ObjectId provided.',
        },
      })
    }

    const order = await Order.findById(rawId).populate('userId', 'name email phone role isActive')
    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'order_not_found',
          message: 'Order not found.',
        },
      })
    }

    const { status, paymentStatus, courier, trackingNumber, trackingUrl, notes, expectedDeliveryDate } = req.body || {}

    // Whitelist and validate Order Status
    if (status !== undefined) {
      const targetStatus = normalizeOrderStatus(status)
      if (!targetStatus) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_order_status',
            message: `Invalid order status: "${status}". Supported values are PENDING_PAYMENT, CONFIRMED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED, CANCELLED.`,
          },
        })
      }

      // Append status history only when status has actually changed
      if (order.status !== targetStatus) {
        // Shipment info is required when transitioning TO Shipped
        if (targetStatus === 'SHIPPED') {
          const providerRaw = courier !== undefined ? courier : order.courier
          if (!providerRaw || typeof providerRaw !== 'string' || !String(providerRaw).trim()) {
            return res.status(400).json({
              success: false,
              error: {
                code: 'shipment_info_required',
                message: 'Delivery Provider (courier) is required when marking an order as Shipped.',
              },
            })
          }
          const urlRaw = trackingUrl !== undefined ? trackingUrl : order.trackingUrl
          const urlCheck = validateTrackingUrl(urlRaw)
          if (!urlCheck.valid) {
            return res.status(400).json({
              success: false,
              error: {
                code: 'shipment_info_required',
                message: urlCheck.error,
              },
            })
          }
        }
        // Phase 2.4H Order State Machine Invariant Protection
        const allowedTransitions = ALLOWED_ORDER_TRANSITIONS[order.status] || []
        if (!allowedTransitions.includes(targetStatus)) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'invalid_order_transition',
              message: `Illegal state transition: order in state "${order.status}" cannot transition to "${targetStatus}".`,
            },
          })
        }

        // Unpaid order cannot be moved to CONFIRMED without valid payment
        if (targetStatus === 'CONFIRMED' && order.paymentStatus !== 'SUCCESS' && order.paymentStatus !== 'PAID') {
          const targetPayment = paymentStatus !== undefined ? normalizePaymentStatus(paymentStatus) : null
          if (targetPayment !== 'SUCCESS' && targetPayment !== 'PAID') {
            return res.status(400).json({
              success: false,
              error: {
                code: 'unpaid_order_confirmation',
                message: 'Cannot confirm order without valid successful payment.',
              },
            })
          }
        }

        // If setting status to CANCELLED via generic update, delegate to authoritative cancellation service
        if (targetStatus === 'CANCELLED') {
          const cancelResult = await cancelOrder({
            orderId: order._id,
            user: req.user,
            role: 'ADMIN',
            reason: typeof notes === 'string' && notes.trim() ? notes.trim() : 'Order cancelled by SV Hub Administration',
            autoRefund: true,
            req,
          })

          if (!cancelResult.success) {
            return res.status(cancelResult.statusCode || 400).json({
              success: false,
              error: {
                code: cancelResult.errorCode || cancelResult.code || 'cancellation_failed',
                message: cancelResult.message || 'Failed to cancel order.',
              },
            })
          }

          const freshOrder = await Order.findById(order._id)
            .populate('userId', 'name email phone role isActive')
            .populate('items.productId', 'name slug price images stock')
          
          return res.json({
            success: true,
            message: 'Order cancelled successfully.',
            order: formatAdminOrder(freshOrder || cancelResult.order),
            refund: cancelResult.refund || null,
          })
        }

        order.history = order.history || []
        order.history.push({
          status: targetStatus,
          at: new Date(),
          note: typeof notes === 'string' && notes.trim()
            ? notes.trim()
            : `Order status changed to ${targetStatus} by admin (${req.user?.email || 'Admin'})`,
        })
        order.status = targetStatus
      }
    }

    // Whitelist and validate Payment Status
    if (paymentStatus !== undefined) {
      const targetPayment = normalizePaymentStatus(paymentStatus)
      if (!targetPayment) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_payment_status',
            message: `Invalid payment status: "${paymentStatus}". Supported values are PENDING, PAID, SUCCESS, FAILED, REFUNDED.`,
          },
        })
      }
      if ((order.paymentStatus === 'SUCCESS' || order.paymentStatus === 'PAID') && targetPayment === 'PENDING') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_payment_transition',
            message: 'Cannot revert captured or successful payment back to PENDING.',
          },
        })
      }
      order.paymentStatus = targetPayment
    }

    // Whitelist and validate Expected Delivery Date
    if (expectedDeliveryDate !== undefined) {
      if (expectedDeliveryDate === null || expectedDeliveryDate === '') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_expected_delivery_date',
            message: 'Expected delivery date cannot be empty.',
          },
        })
      }
      const parsedDate = new Date(expectedDeliveryDate)
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_expected_delivery_date',
            message: 'Invalid expected delivery date format.',
          },
        })
      }

      // Check: Reject dates earlier than order creation day for active (non-delivered, non-cancelled) orders
      const orderCreatedDay = new Date(order.createdAt)
      orderCreatedDay.setHours(0, 0, 0, 0)
      if (order.status !== 'DELIVERED' && order.status !== 'CANCELLED' && parsedDate < orderCreatedDay) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_expected_delivery_date',
            message: 'Expected delivery date cannot be earlier than order creation date for active orders.',
          },
        })
      }

      // Audit trail in order history if date actually changed
      const currentExpected = order.expectedDeliveryDate
        ? new Date(order.expectedDeliveryDate).getTime()
        : (order.createdAt ? new Date(order.createdAt).getTime() + 7 * 86400000 : null)

      if (!currentExpected || parsedDate.getTime() !== currentExpected) {
        const oldStr = currentExpected
          ? new Date(currentExpected).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : 'Initial default'
        const newStr = parsedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        order.history = order.history || []
        order.history.push({
          status: order.status,
          at: new Date(),
          note: `Expected delivery changed: ${oldStr} → ${newStr} by admin (${req.user?.email || 'Admin'})`,
        })
        order.expectedDeliveryDate = parsedDate
      }
    }

    // Whitelist and sanitize Courier
    if (courier !== undefined) {
      if (courier === null || courier === '') {
        order.courier = null
      } else if (typeof courier === 'string') {
        order.courier = courier.trim()
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_courier',
            message: 'Courier must be a string or null.',
          },
        })
      }
    }

    // Whitelist and sanitize Tracking Number
    if (trackingNumber !== undefined) {
      if (trackingNumber === null || trackingNumber === '') {
        order.trackingNumber = null
      } else if (typeof trackingNumber === 'string') {
        order.trackingNumber = trackingNumber.trim()
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_tracking_number',
            message: 'Tracking number must be a string or null.',
          },
        })
      }
    }

    // Whitelist and validate Tracking URL
    if (trackingUrl !== undefined) {
      if (trackingUrl === null || trackingUrl === '') {
        order.trackingUrl = null
      } else if (typeof trackingUrl === 'string') {
        const urlCheck = validateTrackingUrl(trackingUrl)
        if (!urlCheck.valid) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'invalid_tracking_url',
              message: urlCheck.error,
            },
          })
        }
        order.trackingUrl = urlCheck.url
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_tracking_url',
            message: 'Tracking URL must be a string or null.',
          },
        })
      }
    }

    // Whitelist and sanitize Notes
    if (notes !== undefined) {
      if (typeof notes === 'string') {
        order.notes = notes.trim()
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_notes',
            message: 'Notes must be a string.',
          },
        })
      }
    }

    // STRICT IMMUTABILITY:
    // Any other properties in req.body (items, shippingAddress, subtotal, totalAmount, etc.) are ignored.

    await order.save()

    recordAuditLog({
      action: 'ADMIN_ORDER_STATUS_CHANGE',
      actorType: 'ADMIN',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'ORDER',
      resourceId: String(order._id),
      orderId: order._id,
      result: 'SUCCESS',
      metadata: {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        courier: order.courier,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
      },
      req,
    })

    res.json({
      success: true,
      message: 'Order updated successfully.',
      order: formatAdminOrder(order),
    })
  } catch (err) {
    next(err)
  }
}

// 4. POST /api/admin/orders/:id/cancel
export async function cancelAdminOrder(req, res, next) {
  try {
    const rawId = String(req.params.id || '').trim()

    if (!mongoose.isValidObjectId(rawId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_id',
          message: 'Invalid MongoDB ObjectId provided.',
        },
      })
    }

    const { reason, autoRefund = true } = req.body || {}

    const result = await cancelOrder({
      orderId: rawId,
      user: req.user,
      role: 'ADMIN',
      reason,
      autoRefund,
      req,
    })

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        error: {
          code: result.errorCode || result.code || 'cancellation_failed',
          message: result.message || 'Failed to cancel order.',
        },
      })
    }

    const populated = await Order.findById(result.order._id)
      .populate('userId', 'name email phone role isActive')
      .populate('items.productId', 'name slug price images stock')

    return res.status(result.statusCode || 200).json({
      success: true,
      idempotent: Boolean(result.idempotent),
      message: result.message || 'Order cancelled successfully.',
      order: formatAdminOrder(populated || result.order),
      refund: result.refund || null,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * Administrative Payment Reconciliation (POST /api/admin/orders/:id/reconcile)
 * Allows administrators to safely trigger an authoritative reconciliation against Razorpay.
 */
export async function reconcileAdminOrder(req, res, next) {
  try {
    const { id } = req.params
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_id',
          message: 'Valid order ID is required.',
        },
      })
    }

    const order = await Order.findById(id)
    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'order_not_found',
          message: 'Order not found.',
        },
      })
    }

    const reconResult = await reconcileOrderPayment({
      orderId: order._id,
      razorpayOrderId: order.razorpayOrderId,
      force: true,
    })

    const refreshedOrder = await Order.findById(order._id).populate(
      'userId',
      'name email phone role isActive',
    )
    const payment = await Payment.findOne({ orderId: order._id }).sort({ createdAt: -1 })

    // Safe sanitized payment details (zero secrets)
    const safePayment = payment
      ? {
          id: String(payment._id),
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          gateway: payment.gateway,
          razorpayOrderId: payment.razorpayOrderId,
          razorpayPaymentId: payment.razorpayPaymentId,
          verified: payment.verified,
          gatewayStatus: payment.gatewayStatus,
          errorReason: payment.errorReason,
          reconciliationReason: payment.reconciliationReason,
          reconciliationAttempts: payment.reconciliationAttempts,
          lastReconciledAt: payment.lastReconciledAt,
        }
      : null

    return res.status(200).json({
      success: true,
      message: reconResult.message,
      reconciled: reconResult.reconciled,
      classification: reconResult.classification,
      data: {
        order: formatAdminOrder(refreshedOrder || order),
        payment: safePayment,
      },
    })
  } catch (err) {
    next(err)
  }
}

// 7. POST /api/admin/orders/:id/refund (Phase 2.4E)
export async function refundAdminOrder(req, res, next) {
  try {
    const rawId = String(req.params.id || '').trim()

    if (!mongoose.isValidObjectId(rawId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_id',
          message: 'Invalid MongoDB ObjectId provided.',
        },
      })
    }

    const { amount, reason, idempotencyKey, items, speed } = req.body || {}
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'refund_reason_required',
          message: 'A refund reason is required for administrative refunds.',
        },
      })
    }

    const clientKey =
      typeof idempotencyKey === 'string' && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : req.headers['x-idempotency-key'] || null

    const result = await initiateRefund({
      orderId: rawId,
      amount,
      reason,
      user: req.user,
      role: 'admin',
      source: 'admin_request',
      idempotencyKey: clientKey,
      items: Array.isArray(items) ? items : [],
      speed: speed === 'optimum' ? 'optimum' : 'normal',
    })

    if (!result || !result.success) {
      return res.status(result?.statusCode || 400).json({
        success: false,
        error: {
          code: result?.errorCode || 'refund_failed',
          message: result?.message || 'Refund could not be initiated.',
        },
      })
    }

    const refreshedOrder = await Order.findById(rawId)

    return res.status(200).json({
      success: true,
      message: result.message,
      idempotent: Boolean(result.idempotent),
      data: {
        refund: {
          id: result.refund?._id,
          orderId: result.refund?.orderId,
          amount: result.refund?.amount,
          currency: result.refund?.currency,
          status: result.refund?.status,
          reason: result.refund?.reason,
          razorpayRefundId: result.refund?.razorpayRefundId || null,
          isFullRefund: result.refund?.isFullRefund,
          inventoryRestorationStatus: result.refund?.inventoryRestorationStatus,
          createdAt: result.refund?.createdAt,
        },
        order: formatAdminOrder(refreshedOrder),
      },
    })
  } catch (err) {
    next(err)
  }
}

// 8. POST /api/admin/orders/:id/refunds/:refundId/reconcile (Phase 2.4E)
export async function reconcileAdminRefund(req, res, next) {
  try {
    const rawRefundId = String(req.params.refundId || '').trim()

    if (!mongoose.isValidObjectId(rawRefundId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_refund_id',
          message: 'Invalid MongoDB ObjectId provided.',
        },
      })
    }

    const result = await reconcileRefundRecord({ refundId: rawRefundId, force: true })
    if (!result.success) {
      return res.status(result.statusCode || 500).json({
        success: false,
        error: {
          code: 'reconciliation_failed',
          message: result.message || 'Failed to reconcile refund record.',
        },
      })
    }

    return res.status(200).json({
      success: true,
      data: result.refund,
    })
  } catch (err) {
    next(err)
  }
}


