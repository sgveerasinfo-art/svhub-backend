import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  mergeCart,
  applyCartCoupon,
  removeCartCoupon,
  getAvailableCartCoupons,
} from '../controllers/cartController.js'

const cartRouter = Router()

// All Cart routes require authenticated customer session
cartRouter.use(requireAuth)

cartRouter.get('/', getCart)
cartRouter.post('/items', addToCart)
cartRouter.patch('/items/:id', updateCartItem)
cartRouter.delete('/items/:id', removeCartItem)
cartRouter.delete('/', clearCart)
cartRouter.post('/merge', mergeCart)
cartRouter.post('/coupon', applyCartCoupon)
cartRouter.delete('/coupon', removeCartCoupon)
cartRouter.get('/coupons/available', getAvailableCartCoupons)

export { cartRouter }
