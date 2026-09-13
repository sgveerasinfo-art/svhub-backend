import { AuditLog } from '../models/AuditLog.js'
import { env } from '../config/env.js'

/**
 * Sensitive Data Sanitizer:
 * Redacts passwords, tokens, secrets, full payment cards, cookies, and auth headers.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'token',
  'idtoken',
  'resettoken',
  'jwt',
  'secret',
  'keysecret',
  'razorpay_key_secret',
  'webhooksecret',
  'authorization',
  'cookie',
  'cvv',
  'cardnumber',
  'pan',
])

export function sanitizeMetadata(data, depth = 0) {
  if (depth > 5 || !data || typeof data !== 'object') {
    return data
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeMetadata(item, depth + 1))
  }

  const clean = {}
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase().replace(/[-_]/g, '')
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('cvv') ||
      lowerKey.includes('card') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('cookie')
    ) {
      clean[key] = '[REDACTED]'
    } else if (value && typeof value === 'object') {
      clean[key] = sanitizeMetadata(value, depth + 1)
    } else {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Record a durable Security / Operational Audit Log.
 *
 * Safe execution: never throws or disrupts business request flow if logging fails.
 */
export async function recordAuditLog({
  action,
  actorType = 'SYSTEM',
  actorId = null,
  actorEmail = null,
  resourceType = 'SYSTEM',
  resourceId = null,
  orderId = null,
  paymentId = null,
  refundId = null,
  webhookEventId = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
  result = 'SUCCESS',
  reason = null,
  metadata = {},
  req = null,
}) {
  try {
    // Enrich from request object if provided
    let finalActorType = actorType
    let finalActorId = actorId
    let finalActorEmail = actorEmail
    let finalRequestId = requestId
    let finalIp = ipAddress
    let finalUa = userAgent

    if (req) {
      if (!finalRequestId) finalRequestId = req.id || req.requestId || req.headers?.['x-request-id']
      if (!finalIp) finalIp = req.ip || req.connection?.remoteAddress || null
      if (!finalUa) finalUa = typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 255) : null

      if (req.user) {
        finalActorId = finalActorId || req.user._id || req.user.id
        finalActorEmail = finalActorEmail || req.user.email
        const role = String(req.user.role || '').toUpperCase()
        if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
          finalActorType = 'ADMIN'
        } else if (!actorType || actorType === 'SYSTEM' || actorType === 'ANONYMOUS') {
          finalActorType = 'CUSTOMER'
        }
      } else if (finalActorType === 'SYSTEM' && !finalActorId) {
        finalActorType = 'ANONYMOUS'
      }
    }

    const sanitizedMeta = sanitizeMetadata(metadata)

    // Append to MongoDB AuditLog
    const doc = await AuditLog.create({
      action,
      actorType: finalActorType,
      actorId: finalActorId,
      actorEmail: finalActorEmail,
      resourceType,
      resourceId: resourceId ? String(resourceId) : null,
      orderId,
      paymentId,
      refundId,
      webhookEventId,
      requestId: finalRequestId,
      ipAddress: finalIp,
      userAgent: finalUa,
      result,
      reason,
      metadata: sanitizedMeta,
    })

    // Structured logging output in non-test mode
    if (env.NODE_ENV !== 'test') {
      console.log(
        JSON.stringify({
          type: 'AUDIT_LOG',
          action,
          actorType: finalActorType,
          actorId: finalActorId ? String(finalActorId) : undefined,
          resourceType,
          resourceId,
          orderId: orderId ? String(orderId) : undefined,
          paymentId: paymentId ? String(paymentId) : undefined,
          refundId: refundId ? String(refundId) : undefined,
          requestId: finalRequestId,
          result,
          reason,
        }),
      )
    }

    return doc
  } catch (err) {
    console.error('Failed to write audit log record:', err.message)
    return null
  }
}
