import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireAdmin, requirePermission, PERMISSIONS } from '../middleware/requireAdmin.js'
import { adminMutationRateLimiter } from '../middleware/rateLimiter.js'
import {
  getAdminCoupons,
  getAdminCouponById,
  createAdminCoupon,
  updateAdminCoupon,
  disableAdminCoupon,
  archiveAdminCoupon,
} from '../controllers/adminCouponsController.js'

const adminCouponsRouter = Router()

adminCouponsRouter.use(requireAuth, requireAdmin, requirePermission(PERMISSIONS.COUPONS_MANAGE))

adminCouponsRouter.get('/', getAdminCoupons)
adminCouponsRouter.get('/:id', getAdminCouponById)
adminCouponsRouter.post('/', adminMutationRateLimiter, createAdminCoupon)
adminCouponsRouter.patch('/:id', adminMutationRateLimiter, updateAdminCoupon)
adminCouponsRouter.post('/:id/disable', adminMutationRateLimiter, disableAdminCoupon)
adminCouponsRouter.post('/:id/archive', adminMutationRateLimiter, archiveAdminCoupon)
adminCouponsRouter.delete('/:id', adminMutationRateLimiter, archiveAdminCoupon)

export { adminCouponsRouter }
