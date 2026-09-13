import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'
import { fail, jwtSecret } from '../utils/auth.js'
import { recordAuditLog } from '../services/auditLogger.js'

export async function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (!token) {
    recordAuditLog({
      action: 'AUTHORIZATION_DENIED',
      actorType: 'ANONYMOUS',
      resourceType: 'SYSTEM',
      resourceId: req.originalUrl || req.url,
      result: 'DENIED',
      reason: 'Missing Bearer authentication token',
      req,
    })
    return fail(res, 401, 'unauthenticated', 'Please log in to continue.')
  }

  try {
    const payload = jwt.verify(token, jwtSecret())

    if (!payload?.sub) {
      recordAuditLog({
        action: 'AUTHORIZATION_DENIED',
        actorType: 'ANONYMOUS',
        resourceType: 'SYSTEM',
        resourceId: req.originalUrl || req.url,
        result: 'DENIED',
        reason: 'Malformed or missing sub in token',
        req,
      })
      return fail(res, 401, 'invalid_token', 'Invalid session token. Please log in again.')
    }

    const user = await User.findById(payload.sub).select('-passwordHash')
    if (!user) {
      recordAuditLog({
        action: 'AUTHORIZATION_DENIED',
        actorType: 'ANONYMOUS',
        actorId: payload.sub,
        resourceType: 'SYSTEM',
        resourceId: req.originalUrl || req.url,
        result: 'DENIED',
        reason: 'User account not found for token sub',
        req,
      })
      return fail(res, 401, 'unauthenticated', 'User account no longer exists. Please log in again.')
    }

    const tokenVersion = Number(payload.av ?? 0)
    const currentVersion = Number(user.authVersion ?? 0)
    if (tokenVersion !== currentVersion) {
      recordAuditLog({
        action: 'AUTHORIZATION_DENIED',
        actorType: 'ANONYMOUS',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'DENIED',
        reason: 'Session invalidated (authVersion mismatch)',
        req,
      })
      return fail(res, 401, 'session_revoked', 'Your session is no longer valid. Please log in again.')
    }

    const status = String(user.status || 'ACTIVE').toUpperCase()
    if (status === 'SUSPENDED' || status === 'INACTIVE') {
      recordAuditLog({
        action: 'AUTHORIZATION_DENIED',
        actorType: 'CUSTOMER',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'DENIED',
        reason: `Account status is ${status}`,
        req,
      })
      return fail(res, 403, 'account_inactive', 'Your account has been deactivated. Please contact support.')
    }

    req.user = user
    return next()
  } catch (error) {
    recordAuditLog({
      action: 'AUTHORIZATION_DENIED',
      actorType: 'ANONYMOUS',
      resourceType: 'SYSTEM',
      resourceId: req.originalUrl || req.url,
      result: 'DENIED',
      reason: error?.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid session token verification',
      req,
    })
    if (error?.name === 'TokenExpiredError') {
      return fail(res, 401, 'token_expired', 'Your session has expired. Please log in again.')
    }
    return fail(res, 401, 'unauthenticated', 'Invalid session token. Please log in again.')
  }
}
