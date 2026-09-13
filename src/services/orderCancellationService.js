import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { restoreOrderInventory } from '../utils/inventory.js'
import { initiateRefund } from './refundReconciliationService.js'
import { recordAuditLog } from './auditLogger.js'

/**
 * Canonical Order Cancellation Service
 * Unified convergence engine for Customer and Admin cancellation requests.
 *
 * Enforces:
 * 1. Strict ownership and role authorization.
 * 2. Immutable canonical order state machine.
 * 3. Exact-once inventory restoration with per-line accounting (restoredQuantity <= quantity).
 * 4. Automated refund initiation for captured payments with durable idempotency keys.
 * 5. Deterministic idempotent response for already-cancelled orders.
 * 6. Audit logging with sensitive data redaction.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.orderId
 * @param {Object} params.user - Authenticated user object from JWT
 * @param {'customer'|'admin'} params.role
 * @param {string} [params.reason] - Cancellation justification
 * @param {boolean} [params.autoRefund=true] - Whether to initiate automatic refund for paid orders
 * @param {Object} [params.req] - Express request object for correlation/audit
 * @returns {Promise<{ success: boolean, idempotent?: boolean, order?: Object, refund?: Object, message?: string, errorCode?: string, statusCode?: number }>}
 */
export async function cancelOrder({
  orderId,
  user,
  role = 'customer',
  reason = '',
  autoRefund = true,
  req = null,
}) {
  const normRole = String(role || 'customer').toLowerCase()

  // 1. Validate Order ID format
  const rawId = String(orderId || '').trim()
  if (!rawId || !mongoose.isValidObjectId(rawId)) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'invalid_order_id',
      message: 'A valid MongoDB ObjectId is required for order cancellation.',
    }
  }

  // 2. Validate user presence
  if (!user || !user._id) {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'unauthenticated',
      message: 'Authentication is required to cancel orders.',
    }
  }

  // 3. Admin-specific validation
  if (normRole === 'admin') {
    const role = String(user.role || '').toUpperCase()
    const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN'
    if (!isAdmin) {
      return {
        success: false,
        statusCode: 403,
        errorCode: 'forbidden_admin_access',
        message: 'Administrator privileges are required for this action.',
      }
    }
  }

  const cleanReason = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : normRole === 'admin'
      ? 'Order cancelled by SV Hub Administration'
      : 'Cancelled by customer'

  // 4. Initial Lookup & Ownership Check
  const query = normRole === 'customer'
    ? { _id: rawId, userId: user._id }
    : { _id: rawId }

  const initialOrder = await Order.findOne(query)
  if (!initialOrder) {
    return {
      success: false,
      statusCode: 404,
      errorCode: 'order_not_found',
      message: normRole === 'customer'
        ? 'Order not found or does not belong to your account.'
        : 'Order not found.',
    }
  }

  // 5. Check Idempotency: Already Cancelled
  if (initialOrder.status === 'CANCELLED') {
    return {
      success: true,
      idempotent: true,
      order: initialOrder,
      message: 'This order is already cancelled.',
    }
  }

  // 6. Pre-transaction state machine checks
  if (initialOrder.status === 'DELIVERED') {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'cannot_cancel_delivered',
      message: 'Delivered orders cannot be cancelled.',
    }
  }

  if (initialOrder.status === 'SHIPPED' || initialOrder.status === 'OUT_FOR_DELIVERY') {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'cannot_cancel_in_transit',
      message: 'Orders that have already shipped cannot be cancelled directly.',
    }
  }

  // 7. Transactional Cancellation with retry on WriteConflict / TransientTransactionError
  let attempt = 0
  const maxAttempts = 3
  let liveOrder = null
  let wasPaid = false
  let previousStatus = initialOrder.status

  while (attempt < maxAttempts) {
    attempt++
    const session = await mongoose.startSession()
    try {
      session.startTransaction()

      liveOrder = await Order.findOne(query).session(session)
      if (!liveOrder) {
        await session.abortTransaction()
        return {
          success: false,
          statusCode: 404,
          errorCode: 'order_not_found',
          message: 'Order not found.',
        }
      }

      // Check Idempotency inside transaction
      if (liveOrder.status === 'CANCELLED') {
        await session.abortTransaction()
        return {
          success: true,
          idempotent: true,
          order: liveOrder,
          message: 'This order is already cancelled.',
        }
      }

      if (liveOrder.status === 'DELIVERED') {
        await session.abortTransaction()
        return {
          success: false,
          statusCode: 400,
          errorCode: 'cannot_cancel_delivered',
          message: 'Delivered orders cannot be cancelled.',
        }
      }

      if (liveOrder.status === 'SHIPPED' || liveOrder.status === 'OUT_FOR_DELIVERY') {
        await session.abortTransaction()
        return {
          success: false,
          statusCode: 400,
          errorCode: 'cannot_cancel_in_transit',
          message: 'Orders that have already shipped cannot be cancelled directly.',
        }
      }

      previousStatus = liveOrder.status

      // 7.1 Exact-Once Inventory Restoration with Durable Per-Line Accounting
      if (liveOrder.inventoryDeducted === true) {
        const itemsToRestore = []
        for (const item of liveOrder.items || []) {
          const ordered = Number(item.quantity) || 0
          const alreadyRestored = Number(item.restoredQuantity) || 0
          const remainingRestorable = Math.max(0, ordered - alreadyRestored)

          if (remainingRestorable > 0) {
            itemsToRestore.push({
              productId: item.productId,
              variantId: item.variantId,
              quantity: remainingRestorable,
            })
            item.restoredQuantity = ordered
          }
        }

        if (itemsToRestore.length > 0) {
          const restoreRes = await restoreOrderInventory(itemsToRestore, session)
          if (!restoreRes.success) {
            const err = new Error(`Inventory restoration failed: ${restoreRes.error}`)
            if (restoreRes.rawError?.code) err.code = restoreRes.rawError.code
            if (restoreRes.rawError?.codeName) err.codeName = restoreRes.rawError.codeName
            if (restoreRes.rawError?.errorLabels) err.errorLabels = restoreRes.rawError.errorLabels
            throw err
          }
        }
        liveOrder.inventoryRestored = true
      }

      // 7.2 Payment Flagging
      wasPaid =
        liveOrder.paymentStatus === 'SUCCESS' ||
        liveOrder.paymentStatus === 'PAID' ||
        liveOrder.paymentStatus === 'PARTIALLY_REFUNDED'

      if (wasPaid) {
        await Payment.updateOne(
          { orderId: liveOrder._id },
          {
            $set: {
              reconciliationReason: `Order cancelled by ${normRole}; refund pending`,
            },
          },
          { session },
        )
      }

      // 7.3 Transition State to CANCELLED
      liveOrder.status = 'CANCELLED'
      liveOrder.history = liveOrder.history || []
      liveOrder.history.push({
        status: 'CANCELLED',
        at: new Date(),
        note: cleanReason,
        cancelledBy: normRole, // 'admin' | 'customer'
      })

      await liveOrder.save({ session })
      await session.commitTransaction()
      break
    } catch (txErr) {
      await session.abortTransaction().catch(() => {})
      const isTransient =
        txErr.code === 112 ||
        txErr.codeName === 'WriteConflict' ||
        txErr.name === 'WriteConflict' ||
        txErr.message?.includes('Write conflict') ||
        txErr.errorLabels?.has?.('TransientTransactionError') ||
        (Array.isArray(txErr.errorLabels) && txErr.errorLabels.includes('TransientTransactionError'))

      if (isTransient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 50 * attempt))
        continue
      }
      throw txErr
    } finally {
      await session.endSession().catch(() => {})
    }
  }

  // 8. Automated Refund Coordination for Paid Orders
  let refundResult = null
  if (wasPaid && autoRefund) {
    const livePayment = await Payment.findOne({ orderId: liveOrder._id })
    if (livePayment && livePayment.refundableAmount > 0) {
      refundResult = await initiateRefund({
        orderId: liveOrder._id,
        amount: livePayment.refundableAmount,
        reason: `Order cancelled by ${normRole}: ${cleanReason}`,
        user,
        role: normRole,
        source: 'cancellation',
        idempotencyKey: `cancel_rfnd_${liveOrder._id}`,
      })
    }
  }

  // 9. Re-fetch clean updated order doc
  const updatedOrder = await Order.findById(liveOrder._id).populate(
    'userId',
    'name email phone role isActive',
  )

  // 10. Durable Audit Logging
  recordAuditLog({
    action: 'ORDER_CANCELLED',
    actorType: normRole === 'admin' ? 'ADMIN' : 'CUSTOMER',
    actorId: user._id,
    actorEmail: user.email,
    resourceType: 'ORDER',
    resourceId: String(liveOrder._id),
    orderId: liveOrder._id,
    result: 'SUCCESS',
    reason: cleanReason,
    metadata: {
      orderNumber: liveOrder.orderNumber,
      previousStatus,
      newStatus: 'CANCELLED',
      wasPaid,
      refundInitiated: Boolean(refundResult),
      refundStatus: refundResult?.refundDoc?.status || refundResult?.refund?.status || null,
      idempotent: false,
    },
    req,
  })

  return {
    success: true,
    idempotent: false,
    order: updatedOrder || liveOrder,
    refund: refundResult?.refundDoc || refundResult?.refund || null,
    cancellationReason: cleanReason,
    message: 'Order cancelled successfully.',
  }
}
