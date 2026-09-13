import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { Cart } from '../models/Cart.js'
import {
  getRazorpayClient,
  getRazorpayKeyId,
  verifyRazorpaySignature,
  isRazorpayConfigured,
} from '../config/razorpay.js'
import { deductOrderInventory } from '../utils/inventory.js'
import { formatPublicOrder } from './orderController.js'
import { fulfillRazorpayPayment } from '../services/paymentFulfillmentService.js'
import { recordAuditLog } from '../services/auditLogger.js'
import { releaseCouponForOrder } from '../services/couponService.js'

/**
 * 1. Create Razorpay Order (POST /api/payments/razorpay/create-order)
 * Protected by requireAuth.
 * Resolves authoritative SV Hub Order, verifies ownership, and creates a Razorpay order in INR paise.
 * Concurrency protected to prevent duplicate Razorpay orders.
 */
export async function createRazorpayOrder(req, res, next) {
  try {
    const { orderId } = req.body || {}

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_id',
          message: 'SV Hub Order ID is required.',
        },
      })
    }

    const order = await Order.findById(orderId)
    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'order_not_found',
          message: 'Order not found.',
        },
      })
    }

    // Access Control: Customer can only pay for their own order
    if (String(order.userId) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'forbidden_order',
          message: 'You do not have permission to pay for this order.',
        },
      })
    }

    // Status Validation: Order must be payable and still pending payment
    if (order.status !== 'PENDING_PAYMENT') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'order_not_payable',
          message: `Order status is ${order.status}. Only PENDING_PAYMENT orders can initiate payment.`,
        },
      })
    }

    if (order.paymentStatus === 'SUCCESS' || order.paymentStatus === 'PAID') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'already_paid',
          message: 'Order has already been paid.',
        },
      })
    }

    // Authoritative Amount Validation: Must come from MongoDB record
    if (typeof order.totalAmount !== 'number' || order.totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_order_total',
          message: 'Order total is invalid.',
        },
      })
    }

    const amountInPaise = Math.round(order.totalAmount * 100)

    // Check if an existing valid active payment record can be safely reused
    let payment = await Payment.findOne({
      orderId: order._id,
      status: { $in: ['CREATED', 'PENDING'] },
      amount: order.totalAmount,
      razorpayOrderId: { $exists: true, $ne: null, $not: /^CREATING_/ },
    }).sort({ createdAt: -1 })

    let razorpayOrderId = payment?.razorpayOrderId || (order.razorpayOrderId && !order.razorpayOrderId.startsWith('CREATING_') ? order.razorpayOrderId : null)

    if (!razorpayOrderId) {
      // Clear stale creation lock (> 30 seconds old) if previous worker crashed
      if (order.razorpayOrderId && order.razorpayOrderId.startsWith('CREATING_')) {
        const lockTimestamp = parseInt(order.razorpayOrderId.replace('CREATING_', ''), 10)
        if (Number.isFinite(lockTimestamp) && Date.now() - lockTimestamp > 30000) {
          await Order.updateOne(
            { _id: order._id, razorpayOrderId: order.razorpayOrderId },
            { $set: { razorpayOrderId: null } },
          )
        }
      }

      // Concurrency protection: Atomically flag order as CREATING to prevent race condition
      const lockedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          status: 'PENDING_PAYMENT',
          $or: [
            { razorpayOrderId: null },
            { razorpayOrderId: { $exists: false } },
            { razorpayOrderId: { $regex: '^CREATING_' } },
          ],
        },
        { $set: { razorpayOrderId: `CREATING_${Date.now()}` } },
        { new: false },
      )

      if (
        lockedOrder &&
        lockedOrder.razorpayOrderId &&
        lockedOrder.razorpayOrderId.startsWith('CREATING_')
      ) {
        const lockAge = Date.now() - parseInt(lockedOrder.razorpayOrderId.replace('CREATING_', ''), 10)
        // If another request just started within 30s, wait briefly for it to complete
        if (lockAge <= 30000) {
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise((r) => setTimeout(r, 200))
            const refreshed = await Order.findById(order._id)
            if (
              refreshed?.razorpayOrderId &&
              !refreshed.razorpayOrderId.startsWith('CREATING_')
            ) {
              razorpayOrderId = refreshed.razorpayOrderId
              payment = await Payment.findOne({ orderId: order._id, razorpayOrderId })
              break
            }
          }
        }
      }

      if (!razorpayOrderId) {
        const razorpay = getRazorpayClient()
        const options = {
          amount: amountInPaise,
          currency: 'INR',
          receipt: String(order.orderNumber).slice(0, 40),
          notes: {
            svHubOrderId: String(order._id),
            orderNumber: order.orderNumber,
            userId: String(req.user._id),
          },
        }

        let rzpOrder
        try {
          rzpOrder = await razorpay.orders.create(options)
        } catch (rzpErr) {
          // Release lock on gateway error
          await Order.updateOne(
            { _id: order._id, razorpayOrderId: { $regex: '^CREATING_' } },
            { $set: { razorpayOrderId: null } },
          )
          const errorDesc =
            rzpErr.error?.description ||
            rzpErr.message ||
            'Razorpay order creation failed'
          return res.status(rzpErr.statusCode || 502).json({
            success: false,
            error: {
              code: rzpErr.error?.code || 'razorpay_api_error',
              message: `Payment gateway error: ${errorDesc}. Please check your Razorpay Test Mode credentials in svhub-backend/.env.`,
            },
          })
        }
        razorpayOrderId = rzpOrder.id

        // Upsert or create Payment
        payment = await Payment.findOneAndUpdate(
          { orderId: order._id, razorpayOrderId },
          {
            $setOnInsert: {
              orderId: order._id,
              userId: req.user._id,
              amount: order.totalAmount,
              capturedAmount: 0,
              refundedAmount: 0,
              refundableAmount: 0,
              currency: 'INR',
              gateway: 'razorpay',
              status: 'CREATED',
              razorpayOrderId,
            },
          },
          { upsert: true, new: true },
        )

        order.razorpayOrderId = razorpayOrderId
        order.paymentMethod = 'razorpay'
        await order.save()
      }
    }

    recordAuditLog({
      action: 'PAYMENT_ORDER_CREATED',
      actorType: 'CUSTOMER',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'PAYMENT',
      resourceId: razorpayOrderId,
      orderId: order._id,
      result: 'SUCCESS',
      metadata: {
        orderNumber: order.orderNumber,
        razorpayOrderId,
        amountInPaise,
      },
      req,
    })

    return res.status(200).json({
      success: true,
      data: {
        keyId: getRazorpayKeyId(),
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        razorpayOrderId,
        amount: amountInPaise,
        currency: 'INR',
        customer: {
          name: order.customerName,
          email: order.email,
          phone: order.phone,
        },
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * 2. Verify Razorpay Payment (POST /api/payments/razorpay/verify)
 * Protected by requireAuth.
 * Delegates directly to the single authoritative paymentFulfillmentService engine.
 */
export async function verifyRazorpayPayment(req, res, next) {
  try {
    const { orderId, amount } = req.body || {}
    const razorpayOrderId = req.body?.razorpay_order_id || req.body?.razorpayOrderId
    const razorpayPaymentId = req.body?.razorpay_payment_id || req.body?.razorpayPaymentId
    const razorpaySignature = req.body?.razorpay_signature || req.body?.razorpaySignature

    const result = await fulfillRazorpayPayment({
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      user: req.user,
      amount,
      isWebhook: false,
    })

    if (!result.success) {
      recordAuditLog({
        action: 'PAYMENT_VERIFICATION_FAILURE',
        actorType: 'CUSTOMER',
        actorId: req.user._id,
        actorEmail: req.user.email,
        resourceType: 'PAYMENT',
        resourceId: razorpayPaymentId,
        orderId,
        result: 'FAILURE',
        reason: result.message || 'Payment verification failed',
        metadata: {
          errorCode: result.errorCode,
          razorpayOrderId,
          razorpayPaymentId,
        },
        req,
      })
      return res.status(result.statusCode || 400).json({
        success: false,
        error: {
          code: result.errorCode || 'payment_verification_failed',
          message: result.message || 'Payment verification failed.',
        },
        ...(result.data ? { data: result.data } : {}),
      })
    }

    recordAuditLog({
      action: 'PAYMENT_VERIFICATION_SUCCESS',
      actorType: 'CUSTOMER',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'PAYMENT',
      resourceId: razorpayPaymentId,
      orderId: result.order?._id,
      paymentId: result.payment?._id,
      result: 'SUCCESS',
      metadata: {
        orderNumber: result.order?.orderNumber,
        razorpayOrderId,
        razorpayPaymentId,
        amount: result.payment?.amount,
        idempotent: Boolean(result.idempotent),
      },
      req,
    })

    return res.status(200).json({
      success: true,
      message: result.idempotent
        ? 'Payment already verified and order confirmed.'
        : 'Payment verified and order confirmed successfully.',
      data: {
        order: formatPublicOrder(result.order),
        payment: {
          id: String(result.payment._id),
          status: result.payment.status,
          gateway: result.payment.gateway,
          razorpayOrderId: result.payment.razorpayOrderId,
          razorpayPaymentId: result.payment.razorpayPaymentId,
          amount: result.payment.amount,
          currency: result.payment.currency,
        },
        ...(result.idempotent ? { idempotent: true } : {}),
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * Record payment failure / checkout cancellation from client (POST /api/payments/razorpay/record-failure)
 */
export async function recordPaymentFailure(req, res, next) {
  try {
    const { orderId, razorpay_order_id, errorReason } = req.body || {}

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: { code: 'missing_order_id', message: 'Order ID is required.' },
      })
    }

    const order = await Order.findById(orderId)
    if (!order || String(order.userId) !== String(req.user._id)) {
      return res.status(404).json({
        success: false,
        error: { code: 'order_not_found', message: 'Order not found.' },
      })
    }

    if (order.status !== 'CONFIRMED') {
      order.paymentStatus = 'FAILED'
      order.history.push({
        status: order.status,
        at: new Date(),
        note: `Payment attempt failed or cancelled: ${errorReason || 'Checkout cancelled by customer'}`,
      })
      await order.save()
      await releaseCouponForOrder(order._id).catch(() => {})
    }

    if (razorpay_order_id) {
      await Payment.updateOne(
        { orderId: order._id, razorpayOrderId: razorpay_order_id },
        { $set: { status: 'FAILED', errorReason: errorReason || 'Payment failed or cancelled' } },
      )
    }

    recordAuditLog({
      action: 'PAYMENT_VERIFICATION_FAILURE',
      actorType: 'CUSTOMER',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'PAYMENT',
      resourceId: razorpay_order_id || null,
      orderId: order._id,
      result: 'FAILURE',
      reason: errorReason || 'Customer reported payment failure or cancelled checkout',
      req,
    })

    return res.status(200).json({
      success: true,
      message: 'Payment failure recorded.',
    })
  } catch (err) {
    next(err)
  }
}
