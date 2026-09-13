import { fail } from '../utils/auth.js'
import { recordAuditLog } from '../services/auditLogger.js'
import { hasPermission, isStaffRole, PERMISSIONS } from '../utils/adminRoles.js'

export function requireAdmin(req, res, next) {
  if (!req.user) {
    recordAuditLog({
      action: 'AUTHORIZATION_DENIED',
      actorType: 'ANONYMOUS',
      resourceType: 'SYSTEM',
      resourceId: req.originalUrl || req.url,
      result: 'DENIED',
      reason: 'Unauthenticated attempt to access administrative endpoint',
      req,
    })
    return fail(res, 401, 'unauthenticated', 'Please log in to continue.')
  }

  const role = String(req.user.role || '').toUpperCase()

  if (!isStaffRole(role)) {
    recordAuditLog({
      action: 'AUTHORIZATION_DENIED',
      actorType: 'CUSTOMER',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'SYSTEM',
      resourceId: req.originalUrl || req.url,
      result: 'DENIED',
      reason: `Role "${role}" denied administrative access`,
      req,
    })
    return fail(
      res,
      403,
      'forbidden_admin_access',
      'Access denied. Administrator privileges are required to perform this action.',
    )
  }

  return next()
}

export function requirePermission(permission) {
  return function requirePermissionMiddleware(req, res, next) {
    if (!req.user) {
      return fail(res, 401, 'unauthenticated', 'Please log in to continue.')
    }

    const role = String(req.user.role || '').toUpperCase()
    if (!hasPermission(role, permission)) {
      recordAuditLog({
        action: 'AUTHORIZATION_DENIED',
        actorType: isStaffRole(role) ? 'ADMIN' : 'CUSTOMER',
        actorId: req.user._id,
        actorEmail: req.user.email,
        resourceType: 'SYSTEM',
        resourceId: req.originalUrl || req.url,
        result: 'DENIED',
        reason: `Missing permission ${permission}`,
        req,
        metadata: { permission, role },
      })
      return fail(
        res,
        403,
        'forbidden_permission',
        'Access denied. You do not have permission to perform this action.',
      )
    }

    return next()
  }
}

export function requireSuperAdmin(req, res, next) {
  return requirePermission(PERMISSIONS.ACCESS_MANAGE)(req, res, next)
}

export { PERMISSIONS }
