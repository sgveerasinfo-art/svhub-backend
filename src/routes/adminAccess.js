import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireAdmin, requirePermission, PERMISSIONS } from '../middleware/requireAdmin.js'
import { adminMutationRateLimiter } from '../middleware/rateLimiter.js'
import {
  acceptAdminSetup,
  createAdminInvitation,
  listAccessAudit,
  listAdminUsers,
  listPendingInvitations,
  resendAdminInvitation,
  revokeAdminInvitation,
  updateAdminUser,
  validateAdminSetupToken,
} from '../controllers/adminAccessController.js'

const adminAccessRouter = Router()

// Public invitation acceptance (token-gated)
adminAccessRouter.get('/setup', validateAdminSetupToken)
adminAccessRouter.post('/setup', adminMutationRateLimiter, acceptAdminSetup)

// Super Admin manage-access APIs
adminAccessRouter.use(requireAuth, requireAdmin, requirePermission(PERMISSIONS.ACCESS_MANAGE))

adminAccessRouter.get('/users', listAdminUsers)
adminAccessRouter.patch('/users/:id', adminMutationRateLimiter, updateAdminUser)
adminAccessRouter.get('/invitations', listPendingInvitations)
adminAccessRouter.post('/invitations', adminMutationRateLimiter, createAdminInvitation)
adminAccessRouter.post('/invitations/:id/resend', adminMutationRateLimiter, resendAdminInvitation)
adminAccessRouter.post('/invitations/:id/revoke', adminMutationRateLimiter, revokeAdminInvitation)
adminAccessRouter.get('/audit', requirePermission(PERMISSIONS.AUDIT_VIEW), listAccessAudit)

export { adminAccessRouter }
