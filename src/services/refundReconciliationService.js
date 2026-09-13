import mongoose from 'mongoose'
import { Order } from '../models/Order.js'
import { Payment } from '../models/Payment.js'
import { Refund } from '../models/Refund.js'
import { getRazorpayClient } from '../config/razorpay.js'
import { restoreOrderInventory } from '../utils/inventory.js'
import {
  GATEWAY_CLASSIFICATION,
  classifyGatewayError,
} from './paymentReconciliationService.js'
import { recordAuditLog } from './auditLogger.js'

export const MAX_REFUND_RECONCILIATION_ATTEMPTS = 3

/**
 * Initiates a full or partial refund for an order payment.
 * Convergence engine for Customer and Admin refund requests.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.orderId
 * @param {number} [params.amount] - Amount in Rupees. If omitted, full refundable amount is used.
 * @param {string} params.reason - Mandatory audit reason.
 * @param {Object} params.user - Requesting authenticated user doc.
 * @param {'customer'|'admin'|'system'} [params.role='customer']
 * @param {string} [params.source='customer_request']
 * @param {string} [params.idempotencyKey]
 * @param {Array<{productId: string, variantId: string, quantity: number}>} [params.items]
 * @param {'normal'|'optimum'} [params.speed='normal']
 * @returns {Promise<{ success: boolean, idempotent?: boolean, refund?: Object, message?: string, errorCode?: string, statusCode?: number }>}
 */
export async function initiateRefund({
  orderId,
  amount,
  reason,
  user,
  role = null,
  source = 'customer_request',
  idempotencyKey,
  items = [],
  speed = 'normal',
}) {
  if (!orderId || !mongoose.isValidObjectId(orderId)) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'invalid_order_id',
      message: 'A valid orderId is required.',
    }
  }

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'refund_reason_required',
      message: 'A refund reason is required.',
    }
  }

  // 1. Idempotency Check: prevent duplicate refund creation with same key
  const finalIdempotencyKey =
    idempotencyKey ||
    `ref_${orderId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  const existingRefund = await Refund.findOne({ idempotencyKey: finalIdempotencyKey })
  if (existingRefund) {
    return {
      success: true,
      idempotent: true,
      refund: existingRefund,
      message: 'Refund request was already processed (idempotent).',
    }
  }

  // 2. Fetch Order and Payment
  const order = await Order.findById(orderId)
  if (!order) {
    return {
      success: false,
      statusCode: 404,
      errorCode: 'order_not_found',
      message: 'Order not found.',
    }
  }

  // 3. Authorization Check
  const normRole = String(role || user?.role || 'customer').toLowerCase()
  if (normRole === 'customer') {
    if (!user || order.userId.toString() !== user._id.toString()) {
      return {
        success: false,
        statusCode: 403,
        errorCode: 'forbidden_resource',
        message: 'You are not authorized to refund this order.',
      }
    }
  } else if (normRole === 'admin') {
    const role = String(user?.role || '').toUpperCase()
    const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN'
    if (!isAdmin) {
      return {
        success: false,
        statusCode: 403,
        errorCode: 'forbidden_admin_access',
        message: 'Administrator privileges required.',
      }
    }
  }

  const payment = await Payment.findOne({ orderId: order._id })
  if (!payment) {
    return {
      success: false,
      statusCode: 404,
      errorCode: 'payment_not_found',
      message: 'Payment record for this order not found.',
    }
  }

  // 4. Payment Eligibility Check
  const validPaymentStatuses = ['SUCCESS', 'PAID', 'PARTIALLY_REFUNDED']
  if (!validPaymentStatuses.includes(payment.status)) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'payment_not_refundable',
      message: `Cannot refund payment with status "${payment.status}". Payment must be captured/paid.`,
    }
  }

  if (!payment.razorpayPaymentId) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'missing_gateway_payment_id',
      message: 'Payment has no recorded gateway transaction identifier.',
    }
  }

  // Ensure payment accounting fields are populated
  const capturedAmount = payment.capturedAmount ?? payment.amount
  const currentRefunded = payment.refundedAmount || 0
  const availableRefundable = Math.max(0, capturedAmount - currentRefunded)

  // 5. Amount Validation
  let refundRupees = amount !== undefined && amount !== null ? Number(amount) : availableRefundable
  if (!Number.isFinite(refundRupees) || refundRupees <= 0) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'invalid_refund_amount',
      message: 'Refund amount must be a positive number greater than 0.',
    }
  }

  // Precision rounding to 2 decimals
  refundRupees = Math.round(refundRupees * 100) / 100

  if (refundRupees > availableRefundable + 0.001) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'refund_amount_exceeds_refundable',
      message: `Requested refund amount (₹${refundRupees}) exceeds remaining refundable amount (₹${availableRefundable}).`,
    }
  }

  const amountInPaise = Math.round(refundRupees * 100)
  const isFullRefund = Math.abs(refundRupees - availableRefundable) < 0.01 && currentRefunded === 0

  // 5.1 Item Restock Validation: Ensure requested restock does not exceed remaining restorable quantity
  if (Array.isArray(items) && items.length > 0) {
    for (const reqItem of items) {
      const reqQty = Number(reqItem.quantity) || 0
      if (reqQty <= 0) continue
      const matchingOrderItem = (order.items || []).find(
        (oi) =>
          String(oi.productId) === String(reqItem.productId) &&
          String(oi.variantId) === String(reqItem.variantId),
      )
      if (!matchingOrderItem) {
        return {
          success: false,
          statusCode: 400,
          errorCode: 'invalid_refund_item',
          message: `Item ${reqItem.productId} (variant: ${reqItem.variantId}) does not exist in order.`,
        }
      }
      const ordered = Number(matchingOrderItem.quantity) || 0
      const alreadyRestored = Number(matchingOrderItem.restoredQuantity) || 0
      const remaining = Math.max(0, ordered - alreadyRestored)
      if (reqQty > remaining) {
        return {
          success: false,
          statusCode: 400,
          errorCode: 'restock_quantity_exceeds_available',
          message: `Requested restock quantity (${reqQty}) exceeds remaining restorable quantity (${remaining}) for item "${matchingOrderItem.productName || matchingOrderItem.productId}".`,
        }
      }
    }
  }

  // 6. Transactional Reservation & Creation with retry on WriteConflict / TransientTransactionError
  let refundDoc = null
  let reservationAttempts = 0
  const maxReservationAttempts = 3

  while (reservationAttempts < maxReservationAttempts) {
    reservationAttempts++
    const session = await mongoose.startSession()
    try {
      session.startTransaction()

      // Concurrency lock: Re-read live payment inside session to guarantee exact balance
      const livePayment = await Payment.findById(payment._id).session(session)
      const liveCaptured = livePayment.capturedAmount ?? livePayment.amount
      const liveRefunded = livePayment.refundedAmount || 0
      const liveRefundable = livePayment.refundableAmount !== undefined ? livePayment.refundableAmount : Math.max(0, liveCaptured - liveRefunded)

      if (refundRupees > liveRefundable + 0.001) {
        await session.abortTransaction()
        // Check if an existing refund with this exact idempotency key was already created/reserved
        for (let wait = 0; wait < 20; wait++) {
          const idempDoc = await Refund.findOne({ idempotencyKey: finalIdempotencyKey })
          if (idempDoc) {
            return {
              success: true,
              idempotent: true,
              refund: idempDoc,
              message: 'Refund request was already processed (idempotent).',
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }

        return {
          success: false,
          statusCode: 409,
          errorCode: 'concurrent_refund_conflict',
          message: 'Concurrent refund in progress. Remaining refundable amount is insufficient.',
        }
      }

      // Atomically reserve refundable balance immediately to lock out concurrent over-refunds
      livePayment.refundableAmount = Math.max(0, Math.round((liveRefundable - refundRupees) * 100) / 100)
      await livePayment.save({ session })

      // Create initial Refund record in REQUESTED / CREATED status
      const createdRefunds = await Refund.create(
        [
          {
            orderId: order._id,
            paymentId: payment._id,
            userId: order.userId,
            razorpayPaymentId: payment.razorpayPaymentId,
            amount: refundRupees,
            amountInPaise,
            currency: 'INR',
            status: 'CREATED',
            reason: reason.trim(),
            requestedBy: user._id,
            requestedByRole: normRole === 'admin' ? 'admin' : normRole === 'system' ? 'system' : 'customer',
            source: ['customer_request', 'admin_request', 'cancellation', 'webhook', 'reconciliation'].includes(source)
              ? source
              : normRole === 'admin' || source === 'admin'
                ? 'admin_request'
                : 'customer_request',
            idempotencyKey: finalIdempotencyKey,
            isFullRefund,
            items: Array.isArray(items) ? items : [],
            inventoryRestorationStatus: 'NOT_RESTORED',
          },
        ],
        { session },
      )

      refundDoc = createdRefunds[0]
      await session.commitTransaction()
      break
    } catch (err) {
      await session.abortTransaction()
      if (err.code === 11000) {
        // Duplicate idempotencyKey conflict - the other concurrent request may still be committing
        for (let wait = 0; wait < 20; wait++) {
          const dup = await Refund.findOne({ idempotencyKey: finalIdempotencyKey })
          if (dup) {
            return {
              success: true,
              idempotent: true,
              refund: dup,
              message: 'Refund request was already processed (idempotent).',
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      if ((err.errorLabels?.has?.('TransientTransactionError') || err.code === 112) && reservationAttempts < maxReservationAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * reservationAttempts + Math.floor(Math.random() * 20)))
        continue
      }
      if (err.errorLabels?.has?.('TransientTransactionError') || err.code === 112) {
        return {
          success: false,
          statusCode: 409,
          errorCode: 'concurrent_refund_conflict',
          message: 'Concurrent refund operation in progress. Please retry.',
        }
      }
      throw err
    } finally {
      await session.endSession()
    }
  }

  // 7. Invoke Razorpay Gateway API
  let rzpRefund = null
  try {
    const razorpay = getRazorpayClient()
    rzpRefund = await razorpay.payments.refund(payment.razorpayPaymentId, {
      amount: amountInPaise,
      speed: speed === 'optimum' ? 'optimum' : 'normal',
      notes: {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        refundDocId: refundDoc._id.toString(),
        reason: reason.slice(0, 100),
      },
      receipt: refundDoc._id.toString(),
    })
  } catch (gatewayErr) {
    const errorInfo = classifyGatewayError(gatewayErr)

    if (errorInfo.retryable) {
      // Network timeout / 5xx: DO NOT mark failed! Keep in PROCESSING / REQUIRES_RECONCILIATION
      refundDoc.status = 'PROCESSING'
      refundDoc.gatewayStatus = 'uncertain'
      refundDoc.safeFailureReason = `Gateway communication error: ${errorInfo.reason}`
      await refundDoc.save().catch(() => {})

      return {
        success: false,
        statusCode: 502,
        errorCode: 'gateway_timeout',
        message: 'Refund request sent to gateway but confirmation timed out. Background recovery will reconcile.',
        refund: refundDoc,
      }
    }

    // Permanent Gateway Error (e.g. 400 Bad Request, already fully refunded on gateway)
    refundDoc.status = 'FAILED'
    refundDoc.failedAt = new Date()
    refundDoc.failureCode = gatewayErr.code || gatewayErr.error?.code || 'GATEWAY_ERROR'
    refundDoc.safeFailureReason = gatewayErr.error?.description || gatewayErr.message || 'Refund rejected by gateway'
    await refundDoc.save().catch(() => {})

    // Release reserved refundable balance back to Payment
    await Payment.updateOne(
      { _id: payment._id },
      { $inc: { refundableAmount: refundRupees } },
    ).catch(() => {})

    return {
      success: false,
      statusCode: errorInfo.statusCode || 400,
      errorCode: 'gateway_refund_failed',
      message: refundDoc.safeFailureReason,
      refund: refundDoc,
    }
  }

  // 8. Gateway Success: Reconcile and Fulfill Atomically with retry
  let reconcileResult = null
  let lastFulfillError = null
  for (let attempt = 1; attempt <= MAX_REFUND_RECONCILIATION_ATTEMPTS; attempt++) {
    try {
      reconcileResult = await completeRefundFulfillment({
        refundDoc,
        rzpRefund,
        order,
        payment,
        items,
      })
      break
    } catch (fulfillErr) {
      lastFulfillError = fulfillErr
      const isTransient =
        fulfillErr.code === 112 ||
        fulfillErr.codeName === 'WriteConflict' ||
        fulfillErr.name === 'WriteConflict' ||
        fulfillErr.message?.includes('Write conflict') ||
        fulfillErr.message?.includes('WriteConflict') ||
        fulfillErr.errorLabels?.has?.('TransientTransactionError') ||
        (Array.isArray(fulfillErr.errorLabels) && fulfillErr.errorLabels.includes('TransientTransactionError'))
      if (isTransient && attempt < MAX_REFUND_RECONCILIATION_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 60 * attempt + Math.floor(Math.random() * 30)))
        continue
      }
      break
    }
  }

  // 9. Guarantee explicit non-null reconciliation result
  if (!reconcileResult) {
    // Gateway refund succeeded, but local fulfillment exhausted retries due to write conflict / transient error.
    // Transition refund to REQUIRES_RECONCILIATION so background sweeper or webhook will complete local accounting.
    refundDoc.status = 'REQUIRES_RECONCILIATION'
    if (rzpRefund?.id) {
      refundDoc.razorpayRefundId = rzpRefund.id
      refundDoc.gatewayStatus = rzpRefund.status || 'processed'
      refundDoc.rawGatewayResponse = rzpRefund
    }
    refundDoc.safeFailureReason = `Local fulfillment pending reconciliation: ${lastFulfillError?.message || 'Transaction contention'}`
    await refundDoc.save().catch(() => {})

    return {
      success: false,
      statusCode: 503,
      errorCode: 'refund_reconciliation_pending',
      message: 'Refund initiated at payment gateway, but local fulfillment is pending reconciliation.',
      refund: refundDoc,
      order,
    }
  }

  if (!reconcileResult.success) {
    return {
      success: false,
      statusCode: reconcileResult.statusCode || 400,
      errorCode: reconcileResult.errorCode || 'refund_fulfillment_failed',
      message: reconcileResult.message || 'Refund fulfillment failed.',
      refund: reconcileResult.refundDoc || refundDoc,
      order: reconcileResult.order || order,
    }
  }

  return {
    success: true,
    statusCode: 200,
    refund: reconcileResult.refundDoc || refundDoc,
    order: reconcileResult.order || order,
    message: 'Refund initiated and processed successfully.',
    idempotent: Boolean(reconcileResult.idempotent),
  }
}

/**
 * Atomically fulfills local refund accounting, order payment status, and inventory restoration.
 */
export async function completeRefundFulfillment({
  refundDoc,
  rzpRefund,
  order: preloadedOrder = null,
  payment: preloadedPayment = null,
  items = [],
}) {
  const session = await mongoose.startSession()

  try {
    session.startTransaction()

    const liveRefund = await Refund.findById(refundDoc._id).session(session)
    if (!liveRefund) {
      await session.abortTransaction()
      throw new Error(`Refund doc ${refundDoc._id} not found in transaction`)
    }

    if (liveRefund.status === 'PROCESSED') {
      // Already processed idempotently
      await session.commitTransaction()
      return { success: true, idempotent: true, refundDoc: liveRefund }
    }

    const liveOrder = await Order.findById(liveRefund.orderId).session(session)
    const livePayment = await Payment.findById(liveRefund.paymentId).session(session)

    if (!liveOrder || !livePayment) {
      await session.abortTransaction()
      throw new Error('Order or Payment not found during refund fulfillment')
    }

    // Update Refund doc with gateway response details
    if (rzpRefund) {
      liveRefund.razorpayRefundId = rzpRefund.id
      liveRefund.gatewayStatus = rzpRefund.status
      liveRefund.rawGatewayResponse = rzpRefund
    }

    const gatewayIsProcessed = !rzpRefund || rzpRefund.status === 'processed'
    if (gatewayIsProcessed) {
      liveRefund.status = 'PROCESSED'
      liveRefund.processedAt = new Date()
    } else {
      liveRefund.status = 'PROCESSING'
    }

    // Financial Accounting on Payment & Hard Invariant Protection
    const captured = livePayment.capturedAmount ?? livePayment.amount
    const currentRefunded = livePayment.refundedAmount || 0
    if (currentRefunded + liveRefund.amount > captured + 0.001) {
      liveRefund.status = 'REQUIRES_RECONCILIATION'
      liveRefund.safeFailureReason = `Refund amount ₹${liveRefund.amount} exceeds remaining captured balance (captured: ₹${captured}, already refunded: ₹${currentRefunded})`
      await liveRefund.save({ session })
      await session.commitTransaction()
      return {
        success: false,
        statusCode: 400,
        errorCode: 'refund_exceeds_captured',
        message: liveRefund.safeFailureReason,
        refundDoc: liveRefund,
      }
    }

    const newRefunded = currentRefunded + liveRefund.amount
    const newRefundable = Math.max(0, captured - newRefunded)

    livePayment.refundedAmount = Math.round(newRefunded * 100) / 100
    livePayment.refundableAmount = Math.round(newRefundable * 100) / 100

    const isFullyRefunded = livePayment.refundableAmount <= 0.01
    livePayment.status = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    await livePayment.save({ session })

    // Order Payment Status Update (Preserve Order Fulfillment Status, e.g. CANCELLED, DELIVERED)
    liveOrder.paymentStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    liveOrder.history = liveOrder.history || []
    liveOrder.history.push({
      status: liveOrder.status,
      at: new Date(),
      note: `Refund of ₹${liveRefund.amount} processed (${isFullyRefunded ? 'Full refund' : 'Partial refund'}). Razorpay Refund ID: ${liveRefund.razorpayRefundId || 'N/A'}`,
    })

    // Inventory Restoration Invariants (Durable Per-Line Accounting):
    // 1. If order inventory was never deducted, or already fully restored, mark NOT_APPLICABLE.
    // 2. If full refund and inventory was deducted:
    //    Restore only the remaining unrestored quantities for each line item (ordered - restoredQuantity).
    //    Set restoredQuantity = quantity for each item, and set liveOrder.inventoryRestored = true.
    // 3. If partial refund with explicit line items:
    //    Validate that for each line item, restoredQuantity + requestedQty <= orderedQuantity.
    //    Increment restoredQuantity atomically on the order item.
    //    Only restore the requested quantity.
    //    If all order items are now completely restored, set liveOrder.inventoryRestored = true.
    // 4. If partial refund without line items:
    //    Do not guess allocation. Mark inventoryRestorationStatus = 'REQUIRES_RECONCILIATION'.
    if (gatewayIsProcessed) {
      const itemsToConsider =
        Array.isArray(items) && items.length > 0
          ? items
          : Array.isArray(liveRefund.items) && liveRefund.items.length > 0
            ? liveRefund.items
            : []

      if (!liveOrder.inventoryDeducted || liveOrder.inventoryRestored) {
        liveRefund.inventoryRestorationStatus = 'NOT_APPLICABLE'
      } else if (liveRefund.isFullRefund) {
        const itemsToRestore = []
        for (const item of liveOrder.items || []) {
          const ordered = Number(item.quantity) || 0
          const alreadyRestored = Number(item.restoredQuantity) || 0
          const remaining = Math.max(0, ordered - alreadyRestored)
          if (remaining > 0) {
            itemsToRestore.push({
              productId: item.productId,
              variantId: item.variantId,
              quantity: remaining,
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
        liveRefund.inventoryRestorationStatus = 'RESTORED'
      } else if (itemsToConsider.length > 0) {
        const itemsToRestore = []
        for (const reqItem of itemsToConsider) {
          const reqQty = Number(reqItem.quantity) || 0
          if (reqQty <= 0) continue

          const matchingOrderItem = (liveOrder.items || []).find(
            (oi) =>
              String(oi.productId) === String(reqItem.productId) &&
              String(oi.variantId) === String(reqItem.variantId),
          )

          if (!matchingOrderItem) {
            throw new Error(
              `Item ${reqItem.productId} (variant: ${reqItem.variantId}) not found in order`,
            )
          }

          const ordered = Number(matchingOrderItem.quantity) || 0
          const alreadyRestored = Number(matchingOrderItem.restoredQuantity) || 0
          const remaining = Math.max(0, ordered - alreadyRestored)

          if (reqQty > remaining) {
            throw new Error(
              `Requested restock quantity (${reqQty}) exceeds remaining restorable quantity (${remaining}) for item "${matchingOrderItem.productName || matchingOrderItem.productId}"`,
            )
          }

          matchingOrderItem.restoredQuantity = alreadyRestored + reqQty
          itemsToRestore.push({
            productId: matchingOrderItem.productId,
            variantId: matchingOrderItem.variantId,
            quantity: reqQty,
          })
        }

        if (itemsToRestore.length > 0) {
          const restoreRes = await restoreOrderInventory(itemsToRestore, session)
          if (!restoreRes.success) {
            const err = new Error(`Partial inventory restoration failed: ${restoreRes.error}`)
            if (restoreRes.rawError?.code) err.code = restoreRes.rawError.code
            if (restoreRes.rawError?.codeName) err.codeName = restoreRes.rawError.codeName
            if (restoreRes.rawError?.errorLabels) err.errorLabels = restoreRes.rawError.errorLabels
            throw err
          }
        }

        const allRestored = (liveOrder.items || []).every(
          (oi) => (Number(oi.restoredQuantity) || 0) >= (Number(oi.quantity) || 0),
        )
        if (allRestored) {
          liveOrder.inventoryRestored = true
        }
        liveRefund.inventoryRestorationStatus = 'RESTORED'
      } else {
        // Ambiguous partial allocation: do not guess!
        liveRefund.inventoryRestorationStatus = 'REQUIRES_RECONCILIATION'
      }
    }

    await liveOrder.save({ session })
    await liveRefund.save({ session })

    await session.commitTransaction()

    recordAuditLog({
      action: 'REFUND_PROCESSED',
      actorType: liveRefund.requestedByRole === 'admin' ? 'ADMIN' : liveRefund.requestedByRole === 'system' ? 'SYSTEM' : 'CUSTOMER',
      actorId: liveRefund.requestedBy || null,
      resourceType: 'REFUND',
      resourceId: String(liveRefund._id),
      orderId: liveOrder._id,
      paymentId: livePayment._id,
      refundId: liveRefund._id,
      result: 'SUCCESS',
      reason: liveRefund.reason,
      metadata: {
        amount: liveRefund.amount,
        currency: liveRefund.currency,
        razorpayRefundId: liveRefund.razorpayRefundId,
        source: liveRefund.source,
      },
    })

    return { success: true, refundDoc: liveRefund, order: liveOrder, payment: livePayment }
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction().catch(() => {})
    }
    if (err.errorLabels?.has?.('TransientTransactionError') || err.code === 112) {
      const checkRefund = await Refund.findById(refundDoc._id)
      if (checkRefund?.status === 'PROCESSED') {
        return { success: true, idempotent: true, refundDoc: checkRefund }
      }
    }
    throw err
  } finally {
    await session.endSession()
  }
}

/**
 * Handles incoming Razorpay Refund Webhooks.
 *
 * @param {Object} params
 * @param {string} params.eventType - 'refund.processed', 'refund.created', 'refund.failed', 'refund.speed_changed'
 * @param {Object} params.payload - Raw parsed JSON webhook payload
 * @param {Object} params.webhookDoc - Persisted WebhookEvent document
 */
export async function processRefundWebhook({ eventType, payload, webhookDoc }) {
  const refundEntity = payload.payload?.refund?.entity
  if (!refundEntity || !refundEntity.id || !refundEntity.payment_id) {
    if (webhookDoc) {
      webhookDoc.status = 'FAILED_PERMANENT'
      webhookDoc.error = 'Missing refund entity, refund ID, or payment_id in webhook payload'
      await webhookDoc.save().catch(() => {})
    }
    return {
      statusCode: 400,
      success: false,
      errorCode: 'missing_refund_entity',
      message: 'Refund entity with id and payment_id is required.',
    }
  }

  const rzpRefundId = refundEntity.id
  const rzpPaymentId = refundEntity.payment_id
  const amountInPaise = refundEntity.amount
  const amountInRupees = amountInPaise ? amountInPaise / 100 : 0

  if (webhookDoc) {
    webhookDoc.razorpayRefundId = rzpRefundId
    webhookDoc.razorpayPaymentId = rzpPaymentId
    await webhookDoc.save().catch(() => {})
  }

  // 1. Find or correlate local Refund record
  let refund = await Refund.findOne({ razorpayRefundId: rzpRefundId })

  if (!refund) {
    // Try matching by receipt note, orderId note, or pending refund for payment
    const receipt = refundEntity.receipt
    if (receipt && mongoose.isValidObjectId(receipt)) {
      refund = await Refund.findById(receipt)
    }
  }

  if (!refund) {
    // Fallback lookup: find payment and order to construct local record if webhook arrived first
    const payment = await Payment.findOne({ razorpayPaymentId: rzpPaymentId })
    if (payment) {
      // Currency validation
      if (refundEntity.currency && refundEntity.currency.toUpperCase() !== 'INR') {
        if (webhookDoc) {
          webhookDoc.status = 'REQUIRES_RECONCILIATION'
          webhookDoc.error = `Non-INR currency '${refundEntity.currency}' in refund webhook for payment ${rzpPaymentId}`
          await webhookDoc.save().catch(() => {})
        }
        return {
          statusCode: 200,
          success: true,
          message: 'Non-INR refund webhook acknowledged and flagged for reconciliation without mutating financial state.',
        }
      }

      const captured = payment.capturedAmount ?? payment.amount
      const currentRefunded = payment.refundedAmount || 0
      const remainingRefundable = payment.refundableAmount !== undefined ? payment.refundableAmount : Math.max(0, captured - currentRefunded)

      if (amountInRupees > remainingRefundable + 0.001) {
        if (webhookDoc) {
          webhookDoc.status = 'REQUIRES_RECONCILIATION'
          webhookDoc.error = `Webhook refund amount ₹${amountInRupees} exceeds remaining refundable balance ₹${remainingRefundable}`
          await webhookDoc.save().catch(() => {})
        }
        return {
          statusCode: 200,
          success: true,
          message: 'Webhook refund amount exceeds refundable balance; flagged for reconciliation.',
        }
      }

      const order = await Order.findById(payment.orderId)
      if (order) {
        const isFull = Math.abs(amountInRupees - remainingRefundable) < 0.01 && currentRefunded === 0
        refund = await Refund.create({
          orderId: order._id,
          paymentId: payment._id,
          userId: order.userId,
          razorpayPaymentId: rzpPaymentId,
          razorpayRefundId: rzpRefundId,
          amount: amountInRupees,
          amountInPaise,
          currency: 'INR',
          status: 'CREATED',
          reason: refundEntity.notes?.reason || 'Refund initiated via Razorpay dashboard / webhook',
          requestedBy: order.userId,
          requestedByRole: 'system',
          source: 'webhook',
          idempotencyKey: `wh_ref_${rzpRefundId}`,
          isFullRefund: isFull,
          inventoryRestorationStatus: 'NOT_RESTORED',
          rawGatewayResponse: refundEntity,
        })
      }
    }
  }

  if (!refund) {
    if (webhookDoc) {
      webhookDoc.status = 'REQUIRES_RECONCILIATION'
      webhookDoc.reconciliationReason = `Payment ${rzpPaymentId} not found locally for refund ${rzpRefundId}`
      await webhookDoc.save().catch(() => {})
    }
    return {
      statusCode: 200,
      success: true,
      message: 'Refund webhook received but associated local payment not found; flagged for reconciliation.',
    }
  }

  // 2. Process based on Event Type
  switch (eventType) {
    case 'refund.processed': {
      if (refund.status === 'PROCESSED') {
        if (webhookDoc) {
          webhookDoc.status = 'PROCESSED'
          webhookDoc.processedAt = new Date()
          webhookDoc.orderId = refund.orderId
          await webhookDoc.save().catch(() => {})
        }
        return {
          statusCode: 200,
          success: true,
          idempotent: true,
          message: 'Refund was already processed (idempotent webhook acknowledgement).',
        }
      }

      // Complete fulfillment
      const fulfillRes = await completeRefundFulfillment({
        refundDoc: refund,
        rzpRefund: refundEntity,
      })

      if (webhookDoc) {
        webhookDoc.status = 'PROCESSED'
        webhookDoc.processedAt = new Date()
        webhookDoc.orderId = refund.orderId
        await webhookDoc.save().catch(() => {})
      }

      return {
        statusCode: 200,
        success: true,
        message: 'Refund processed successfully via webhook.',
      }
    }

    case 'refund.failed': {
      // Invariant: PROCESSED cannot transition to FAILED!
      if (refund.status === 'PROCESSED') {
        if (webhookDoc) {
          webhookDoc.status = 'IGNORED'
          webhookDoc.processedAt = new Date()
          webhookDoc.error = 'Stale refund.failed webhook ignored: refund already PROCESSED'
          await webhookDoc.save().catch(() => {})
        }
        return {
          statusCode: 200,
          success: true,
          message: 'Stale refund.failed ignored; local refund is already PROCESSED.',
        }
      }

      refund.status = 'FAILED'
      refund.failedAt = new Date()
      refund.failureCode = refundEntity.error_code || 'REFUND_FAILED'
      refund.safeFailureReason = refundEntity.error_description || 'Refund failed at gateway'
      refund.gatewayStatus = 'failed'
      refund.rawGatewayResponse = refundEntity
      await refund.save()

      if (webhookDoc) {
        webhookDoc.status = 'PROCESSED'
        webhookDoc.processedAt = new Date()
        webhookDoc.orderId = refund.orderId
        await webhookDoc.save().catch(() => {})
      }

      return {
        statusCode: 200,
        success: true,
        message: 'Refund failure recorded from webhook.',
      }
    }

    case 'refund.created':
    case 'refund.speed_changed':
    default: {
      refund.gatewayStatus = refundEntity.status || 'pending'
      refund.rawGatewayResponse = refundEntity
      await refund.save()

      if (webhookDoc) {
        webhookDoc.status = 'PROCESSED'
        webhookDoc.processedAt = new Date()
        webhookDoc.orderId = refund.orderId
        await webhookDoc.save().catch(() => {})
      }

      return {
        statusCode: 200,
        success: true,
        message: `Refund event "${eventType}" acknowledged and updated.`,
      }
    }
  }
}

/**
 * Queries Razorpay server-to-server to reconcile a specific refund record.
 */
export async function reconcileRefundRecord({ refundId, force = false }) {
  if (!refundId || !mongoose.isValidObjectId(refundId)) {
    return { success: false, statusCode: 400, message: 'Invalid refundId.' }
  }

  const refund = await Refund.findById(refundId)
  if (!refund) {
    return { success: false, statusCode: 404, message: 'Refund not found.' }
  }

  if (refund.status === 'PROCESSED' && !force) {
    return { success: true, idempotent: true, refund }
  }

  if (!refund.razorpayRefundId) {
    return {
      success: false,
      statusCode: 400,
      message: 'Refund has no razorpayRefundId to query gateway.',
    }
  }

  let rzpRefund = null
  try {
    const razorpay = getRazorpayClient()
    rzpRefund = await razorpay.refunds.fetch(refund.razorpayRefundId)
  } catch (err) {
    const classified = classifyGatewayError(err)
    refund.reconciliationAttempts = (refund.reconciliationAttempts || 0) + 1
    refund.lastReconciledAt = new Date()
    await refund.save().catch(() => {})

    return {
      success: false,
      statusCode: classified.statusCode || 502,
      classification: classified.classification,
      message: `Gateway query error: ${classified.reason}`,
    }
  }

  if (rzpRefund.status === 'processed') {
    const fulfillRes = await completeRefundFulfillment({
      refundDoc: refund,
      rzpRefund,
    })
    return { success: true, refund: fulfillRes.refundDoc }
  } else if (rzpRefund.status === 'failed') {
    if (refund.status !== 'PROCESSED') {
      refund.status = 'FAILED'
      refund.failedAt = new Date()
      refund.failureCode = rzpRefund.error_code
      refund.safeFailureReason = rzpRefund.error_description
      refund.gatewayStatus = 'failed'
      await refund.save()
    }
    return { success: true, refund }
  }

  refund.gatewayStatus = rzpRefund.status
  refund.lastReconciledAt = new Date()
  await refund.save()

  return { success: true, refund }
}

/**
 * Scans for stale REQUESTED, CREATED, or PROCESSING refunds and reconciles them.
 */
export async function recoverStaleRefunds({
  staleThresholdMs = 300000, // 5 minutes
  limit = 20,
} = {}) {
  const cutoff = new Date(Date.now() - staleThresholdMs)

  const staleRefunds = await Refund.find({
    status: { $in: ['REQUESTED', 'CREATED', 'PROCESSING', 'REQUIRES_RECONCILIATION'] },
    razorpayRefundId: { $ne: null },
    $or: [
      { lockedAt: null },
      { lockedAt: { $lt: cutoff } },
    ],
  }).limit(limit)

  const results = []
  for (const item of staleRefunds) {
    // Atomic lease claim
    const claimed = await Refund.findOneAndUpdate(
      {
        _id: item._id,
        status: { $in: ['REQUESTED', 'CREATED', 'PROCESSING', 'REQUIRES_RECONCILIATION'] },
        $or: [
          { lockedAt: null },
          { lockedAt: { $lt: cutoff } },
        ],
      },
      {
        $set: {
          lockedAt: new Date(),
          lockOwner: 'refund-recovery-worker',
        },
        $inc: { reconciliationAttempts: 1 },
      },
      { new: true },
    )

    if (!claimed) continue

    try {
      const res = await reconcileRefundRecord({ refundId: claimed._id, force: true })
      claimed.lockedAt = null
      claimed.lastReconciledAt = new Date()
      await claimed.save().catch(() => {})
      results.push({ refundId: claimed._id, status: claimed.status, success: res.success })
    } catch (err) {
      claimed.lockedAt = null
      await claimed.save().catch(() => {})
      results.push({ refundId: claimed._id, success: false, error: err.message })
    }
  }

  return { scanned: staleRefunds.length, recovered: results.length, results }
}
