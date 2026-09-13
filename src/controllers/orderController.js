import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { Cart } from '../models/Cart.js'
import { Product } from '../models/Product.js'
import { Payment } from '../models/Payment.js'
import { Address } from '../models/Address.js'
import { Settings } from '../models/Settings.js'
import { Counter } from '../models/Counter.js'
import { restoreOrderInventory } from '../utils/inventory.js'
import { initiateRefund } from '../services/refundReconciliationService.js'
import { recordAuditLog } from '../services/auditLogger.js'
import { cancelOrder } from '../services/orderCancellationService.js'
import {
  validateAndQuote,
  buildOrderCouponSnapshot,
  reserveCouponRedemption,
} from '../services/couponService.js'
import { normalizeCouponCode } from '../models/Coupon.js'

export function formatPublicOrder(order) {
  const cancelHistory = Array.isArray(order.history)
    ? [...order.history].reverse().find((h) => h.status === 'CANCELLED')
    : null

  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    userId: String(order.userId),
    customerName: order.customerName,
    email: order.email,
    phone: order.phone,
    shippingAddress: order.shippingAddress,
    items: (order.items || []).map((item) => ({
      productId: String(item.productId),
      variantId: item.variantId,
      productName: item.productName,
      variantLabel: item.variantLabel,
      weight: item.weight || '',
      sku: item.sku,
      unitPrice: item.unitPrice,
      originalPrice: item.originalPrice || null,
      discount: item.discount || null,
      quantity: item.quantity,
      restoredQuantity: item.restoredQuantity || 0,
      lineTotal: item.lineTotal,
      image: item.image || '',
      storefront: item.storefront || '',
    })),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    discount: order.discount,
    coupon: order.coupon
      ? {
          code: order.coupon.code,
          discountType: order.coupon.discountType,
          discountValue: order.coupon.discountValue,
          maxDiscount: order.coupon.maxDiscount ?? null,
          discountAmount: order.coupon.discountAmount,
          productScope: order.coupon.productScope,
          customerEligibility: order.coupon.customerEligibility,
        }
      : null,
    totalAmount: order.totalAmount,
    status: order.status,
    cancellationReason: cancelHistory?.note || null,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod || null,
    paymentId: order.paymentId || null,
    razorpayOrderId: order.razorpayOrderId || null,
    courier: order.courier || null,
    trackingNumber: order.trackingNumber || null,
    trackingUrl: order.trackingUrl || null,
    notes: order.notes || '',
    expectedDeliveryDate:
      order.expectedDeliveryDate ||
      (order.createdAt
        ? new Date(new Date(order.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    history: order.history || [],
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  }
}

// 1. Create Application Order (POST /api/orders)
export async function createOrder(req, res, next) {
  try {
    const userId = req.user._id

    // 1. Load customer's persistent cart from MongoDB
    const cart = await Cart.findOne({ userId })
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'empty_cart',
          message: 'Cannot place an order with an empty cart.',
        },
      })
    }

    // 2. Resolve every cart line against live MongoDB Product & Variant data
    const productIds = cart.items.map((i) => i.productId)
    const products = await Product.find({ _id: { $in: productIds } })
    const productMap = new Map(products.map((p) => [String(p._id), p]))

    const orderItems = []
    let subtotal = 0

    for (const item of cart.items) {
      const product = productMap.get(String(item.productId))
      if (!product || product.isActive === false) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'product_unavailable',
            message: `Product "${product ? product.name : item.productId}" is discontinued or unavailable.`,
          },
        })
      }

      const variant = (product.variants || []).find(
        (v) => v.variantId === item.variantId && v.isActive !== false,
      )
      if (!variant) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'variant_unavailable',
            message: `Selected pack variant "${item.variantId}" for "${product.name}" is no longer available.`,
          },
        })
      }

      const qty = item.quantity
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_quantity',
            message: `Invalid quantity ${qty} for "${product.name}".`,
          },
        })
      }

      if (qty > variant.qty) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'insufficient_stock',
            message: `Insufficient stock for "${product.name} (${variant.label})". Requested: ${qty}, Available: ${variant.qty}.`,
          },
        })
      }

      // Authoritative server-side price calculation
      const unitPrice = variant.price
      const lineTotal = unitPrice * qty
      subtotal += lineTotal

      orderItems.push({
        productId: product._id,
        variantId: variant.variantId,
        productName: product.name,
        variantLabel: variant.label,
        weight: variant.weight || '',
        sku: variant.sku,
        unitPrice,
        originalPrice: variant.originalPrice || null,
        discount: variant.discount || null,
        quantity: qty,
        lineTotal,
        image: product.image,
        storefront: product.storefront || '',
      })
    }

    // 3. Resolve and validate delivery address
    let shippingAddress = null
    const { addressId, shippingAddress: customAddress } = req.body || {}

    if (addressId) {
      if (!mongoose.isValidObjectId(addressId)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_address_id',
            message: 'Invalid addressId specified.',
          },
        })
      }

      // Strictly verify customer ownership of address
      const ownedAddress = await Address.findOne({ _id: addressId, userId })
      if (!ownedAddress) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'address_not_found',
            message: 'Delivery address not found or not owned by your account.',
          },
        })
      }

      const streetLine = [ownedAddress.house, ownedAddress.street, ownedAddress.area].filter(Boolean).join(', ') || ownedAddress.street
      shippingAddress = {
        name: ownedAddress.name,
        phone: ownedAddress.phone,
        house: ownedAddress.house || '',
        street: ownedAddress.street,
        area: ownedAddress.area || '',
        landmark: ownedAddress.landmark || '',
        city: ownedAddress.city,
        state: ownedAddress.state,
        pin: ownedAddress.pin,
        country: ownedAddress.country || 'India',
        latitude: ownedAddress.location?.latitude ?? null,
        longitude: ownedAddress.location?.longitude ?? null,
        lines: [
          streetLine,
          `${ownedAddress.city}, ${ownedAddress.state}`,
          `${ownedAddress.pin}, ${ownedAddress.country || 'India'}`,
        ],
      }
    } else if (customAddress && typeof customAddress === 'object') {
      const name = String(customAddress.name || '').trim()
      const phone = String(customAddress.phone || '').trim()
      const house = String(customAddress.house || '').trim()
      const street = String(customAddress.street || '').trim()
      const area = String(customAddress.area || '').trim()
      const landmark = String(customAddress.landmark || '').trim()
      const city = String(customAddress.city || '').trim()
      const state = String(customAddress.state || '').trim()
      const pin = String(customAddress.pin || '').trim()
      const country = String(customAddress.country || 'India').trim()
      const lat = Number.isFinite(Number(customAddress.latitude)) ? Number(customAddress.latitude) : null
      const lng = Number.isFinite(Number(customAddress.longitude)) ? Number(customAddress.longitude) : null

      if (!name || name.length < 2) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_name',
            message: 'Recipient name must be at least 2 characters.',
          },
        })
      }
      if (!phone) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_phone',
            message: 'Delivery contact phone is required.',
          },
        })
      }
      if (!street || !city || !state) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_address',
            message: 'Complete street, city, and state are required.',
          },
        })
      }
      if (!pin || !/^\d{6}$/.test(pin)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'invalid_pin',
            message: 'A valid 6-digit PIN code is required.',
          },
        })
      }

      const streetLine = [house, street, area].filter(Boolean).join(', ') || street
      shippingAddress = {
        name,
        phone,
        house,
        street,
        area,
        landmark,
        city,
        state,
        pin,
        country,
        latitude: lat,
        longitude: lng,
        lines: [
          streetLine,
          `${city}, ${state}`,
          `${pin}, ${country}`,
        ],
      }
    } else {
      // Fallback to customer's default address if present
      const defaultAddr = await Address.findOne({ userId, isDefault: true })
      if (defaultAddr) {
        shippingAddress = {
          name: defaultAddr.name,
          phone: defaultAddr.phone,
          street: defaultAddr.street,
          city: defaultAddr.city,
          state: defaultAddr.state,
          pin: defaultAddr.pin,
          country: defaultAddr.country || 'India',
          lines: [
            defaultAddr.street,
            `${defaultAddr.city}, ${defaultAddr.state}`,
            `${defaultAddr.pin}, ${defaultAddr.country || 'India'}`,
          ],
        }
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: 'missing_address',
            message: 'A valid delivery address is required to place an order.',
          },
        })
      }
    }

    // 4. Calculate Shipping Fee from Settings singleton
    const settings = await Settings.getSettings()
    const shippingMethod = String(
      req.body?.shippingMethod || req.body?.delivery || 'standard',
    ).toLowerCase()

    if (shippingMethod !== 'standard' && shippingMethod !== 'express') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_shipping_method',
          message: 'Shipping method must be either "standard" or "express".',
        },
      })
    }

    let shippingFee = 0
    if (shippingMethod === 'express') {
      shippingFee = settings.expressShippingFee ?? 120
    } else {
      // Standard shipping: Free if subtotal >= freeShippingThreshold
      const threshold = settings.freeShippingThreshold ?? 499
      if (subtotal >= threshold) {
        shippingFee = 0
      } else {
        shippingFee = settings.standardShippingFee ?? 40
      }
    }

    // Coupon: revalidate server-side from cart (body couponCode may override if it matches a valid quote)
    const bodyCouponCode = normalizeCouponCode(req.body?.couponCode)
    const cartCouponCode = normalizeCouponCode(cart.appliedCouponCode)
    const couponCodeToApply = bodyCouponCode || cartCouponCode

    let discount = 0
    let couponSnapshot = null
    let couponQuote = null

    if (couponCodeToApply) {
      if (bodyCouponCode && cartCouponCode && bodyCouponCode !== cartCouponCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'coupon_mismatch',
            message: 'Coupon on the request does not match the coupon applied to your cart.',
          },
        })
      }

      const couponResult = await validateAndQuote({
        code: couponCodeToApply,
        cartItems: cart.items,
        userId,
      })

      if (!couponResult.ok) {
        return res.status(400).json({
          success: false,
          error: couponResult.error,
        })
      }

      couponQuote = couponResult.quote
      discount = couponQuote.discountAmount
      couponSnapshot = buildOrderCouponSnapshot(couponQuote)
    }

    const totalAmount = Math.max(0, subtotal + shippingFee - discount)

    // 5. Generate Atomic Sequential Order Number
    const seq = await Counter.getNextSequence('order_number')
    const orderNumber = `#SVH-${seq}`

    // 6. Create Application Order Document + optional RESERVED coupon redemption
    // CRITICAL: Stock is NOT deducted in Phase 1.5; Cart is NOT cleared in Phase 1.5
    // Coupon stays on cart until payment success so retries can re-use the same code.
    let order
    try {
      order = await Order.create({
        orderNumber,
        userId,
        customerName: shippingAddress.name || req.user.name,
        email: req.user.email,
        phone: shippingAddress.phone || req.user.phone || '',
        shippingAddress,
        items: orderItems,
        subtotal,
        shippingFee,
        discount,
        coupon: couponSnapshot,
        totalAmount,
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() : '',
        history: [
          {
            status: 'PENDING_PAYMENT',
            at: new Date(),
            note: couponSnapshot
              ? `Application order created with coupon ${couponSnapshot.code}; awaiting gateway payment initiation`
              : 'Application order created; awaiting gateway payment initiation',
          },
        ],
      })

      if (couponQuote) {
        // Re-check limits immediately before reserve to reduce race window
        const recheck = await validateAndQuote({
          code: couponQuote.code,
          cartItems: cart.items,
          userId,
          excludeOrderId: order._id,
        })
        if (!recheck.ok) {
          await Order.deleteOne({ _id: order._id })
          return res.status(400).json({
            success: false,
            error: recheck.error,
          })
        }
        await reserveCouponRedemption({
          quote: couponQuote,
          userId,
          orderId: order._id,
        })
      }
    } catch (createErr) {
      if (order?._id) {
        await Order.deleteOne({ _id: order._id }).catch(() => {})
      }
      throw createErr
    }

    recordAuditLog({
      action: 'ORDER_CREATED',
      actorType: 'CUSTOMER',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'ORDER',
      resourceId: String(order._id),
      orderId: order._id,
      result: 'SUCCESS',
      metadata: {
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        itemCount: order.items?.length || 0,
      },
      req,
    })

    res.status(201).json({
      success: true,
      data: formatPublicOrder(order),
    })
  } catch (err) {
    next(err)
  }
}

// 2. Get customer's order history (GET /api/orders)
export async function getCustomerOrders(req, res, next) {
  try {
    const rawLimit = parseInt(req.query.limit, 10)
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(50, rawLimit) : 20

    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(limit)

    res.json({
      success: true,
      data: orders.map(formatPublicOrder),
    })
  } catch (err) {
    next(err)
  }
}

// 3. Get customer order details by ID or orderNumber (GET /api/orders/:id)
export async function getCustomerOrderById(req, res, next) {
  try {
    const identifier = String(req.params.id || '').trim()

    let query
    if (mongoose.isValidObjectId(identifier)) {
      query = { _id: identifier, userId: req.user._id }
    } else {
      // Tolerate optional leading '#', case-insensitivity (e.g. #SVH-10265, SVH-10265, svh-10265)
      const cleanNumber = identifier.replace(/^#/, '').trim()
      const escaped = cleanNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      query = {
        orderNumber: new RegExp(`^#?${escaped}$`, 'i'),
        userId: req.user._id,
      }
    }

    const order = await Order.findOne(query)
    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'order_not_found',
          message: 'Order not found or does not belong to your account.',
        },
      })
    }

    res.json({
      success: true,
      data: formatPublicOrder(order),
    })
  } catch (err) {
    next(err)
  }
}

// 4. Cancel customer order (POST /api/orders/:id/cancel)
export async function cancelCustomerOrder(req, res, next) {
  try {
    const rawId = String(req.params.id || '').trim()
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''

    const result = await cancelOrder({
      orderId: rawId,
      user: req.user,
      role: 'customer',
      reason,
      autoRefund: true,
      req,
    })

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        error: {
          code: result.errorCode || 'cancellation_failed',
          message: result.message || 'Order could not be cancelled.',
        },
      })
    }

    return res.status(200).json({
      success: true,
      message: result.message,
      idempotent: Boolean(result.idempotent),
      data: formatPublicOrder(result.order),
      refund: result.refund || null,
    })
  } catch (err) {
    next(err)
  }
}

