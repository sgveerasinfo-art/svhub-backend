import mongoose from 'mongoose'
import { Coupon, normalizeCouponCode, deriveCouponStatus } from '../models/Coupon.js'
import { CouponRedemption } from '../models/CouponRedemption.js'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'

export const COUPON_ERROR = {
  MISSING_CODE: 'coupon_missing_code',
  NOT_FOUND: 'coupon_not_found',
  DISABLED: 'coupon_disabled',
  ARCHIVED: 'coupon_archived',
  SCHEDULED: 'coupon_scheduled',
  EXPIRED: 'coupon_expired',
  EMPTY_CART: 'coupon_empty_cart',
  MIN_CART: 'coupon_min_cart',
  NO_ELIGIBLE_ITEMS: 'coupon_no_eligible_items',
  CUSTOMER_NEW_ONLY: 'coupon_new_customers_only',
  CUSTOMER_EXISTING_ONLY: 'coupon_existing_customers_only',
  LOGIN_REQUIRED: 'coupon_login_required',
  USAGE_LIMIT: 'coupon_usage_limit',
  PER_CUSTOMER_LIMIT: 'coupon_per_customer_limit',
  ZERO_DISCOUNT: 'coupon_zero_discount',
}

const USER_MESSAGES = {
  [COUPON_ERROR.MISSING_CODE]: 'Enter a coupon code.',
  [COUPON_ERROR.NOT_FOUND]: 'This coupon code is not valid.',
  [COUPON_ERROR.DISABLED]: 'This coupon is currently unavailable.',
  [COUPON_ERROR.ARCHIVED]: 'This coupon is no longer available.',
  [COUPON_ERROR.SCHEDULED]: 'This coupon is not active yet.',
  [COUPON_ERROR.EXPIRED]: 'This coupon has expired.',
  [COUPON_ERROR.EMPTY_CART]: 'Add items to your cart before applying a coupon.',
  [COUPON_ERROR.MIN_CART]: 'Your cart does not meet the minimum amount for this coupon.',
  [COUPON_ERROR.NO_ELIGIBLE_ITEMS]: 'No items in your cart are eligible for this coupon.',
  [COUPON_ERROR.CUSTOMER_NEW_ONLY]: 'This coupon is only for new customers.',
  [COUPON_ERROR.CUSTOMER_EXISTING_ONLY]: 'This coupon is only for existing customers.',
  [COUPON_ERROR.LOGIN_REQUIRED]: 'Sign in to apply this coupon.',
  [COUPON_ERROR.USAGE_LIMIT]: 'This coupon has reached its usage limit.',
  [COUPON_ERROR.PER_CUSTOMER_LIMIT]: 'You have already used this coupon the maximum number of times.',
  [COUPON_ERROR.ZERO_DISCOUNT]: 'This coupon does not apply a discount to your cart.',
}

export function couponErrorMessage(code, fallback) {
  return USER_MESSAGES[code] || fallback || 'Unable to apply this coupon.'
}

export function couponFailure(code, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      message: couponErrorMessage(code),
      ...extra,
    },
  }
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

const PRIOR_ORDER_STATUSES = [
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

/**
 * True if the user has at least one prior successful/completed purchase.
 */
export async function userHasPriorPurchase(userId, session = null) {
  if (!userId) return false
  const query = Order.findOne({
    userId,
    $or: [
      { status: { $in: PRIOR_ORDER_STATUSES } },
      { paymentStatus: { $in: ['SUCCESS', 'PAID'] } },
    ],
  }).select('_id')
  if (session) query.session(session)
  const found = await query.lean()
  return Boolean(found)
}

/**
 * Resolve live cart lines from raw cart items (productId + variantId + quantity).
 * @returns {{ lines: Array, fullSubtotal: number }}
 */
export async function resolveCartLines(rawItems = [], session = null) {
  const items = Array.isArray(rawItems) ? rawItems : []
  if (items.length === 0) return { lines: [], fullSubtotal: 0 }

  const productIds = [...new Set(items.map((i) => String(i.productId)))]
  const query = Product.find({ _id: { $in: productIds } }).select(
    'name slug category isActive variants.variantId variants.price variants.isActive variants.qty',
  )
  if (session) query.session(session)
  const products = await query.lean()
  const productMap = new Map(products.map((p) => [String(p._id), p]))

  const lines = []
  let fullSubtotal = 0

  for (const item of items) {
    const product = productMap.get(String(item.productId))
    if (!product || product.isActive === false) continue
    const variant = (product.variants || []).find((v) => v.variantId === item.variantId)
    if (!variant || variant.isActive === false) continue
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1))
    const price = Number(variant.price) || 0
    const lineTotal = roundMoney(price * qty)
    lines.push({
      productId: String(product._id),
      variantId: variant.variantId,
      category: product.category || '',
      quantity: qty,
      price,
      lineTotal,
    })
    fullSubtotal += lineTotal
  }

  return { lines, fullSubtotal: roundMoney(fullSubtotal) }
}

function lineIsEligible(line, coupon) {
  const productSelected = coupon.productScope === 'SELECTED'
  const categorySelected = coupon.categoryScope === 'SELECTED'

  if (!productSelected && !categorySelected) return true

  const productIds = (coupon.productIds || []).map(String)
  const categorySlugs = (coupon.categorySlugs || []).map((s) => String(s).toLowerCase())
  const inProducts = productSelected && productIds.includes(String(line.productId))
  const inCategories =
    categorySelected && categorySlugs.includes(String(line.category || '').toLowerCase())

  if (productSelected && categorySelected) return inProducts || inCategories
  if (productSelected) return inProducts
  return inCategories
}

function computeDiscountAmount(coupon, eligibleSubtotal) {
  const value = Number(coupon.discountValue) || 0
  if (eligibleSubtotal <= 0 || value <= 0) return 0

  let amount = 0
  if (coupon.discountType === 'PERCENTAGE') {
    amount = roundMoney((eligibleSubtotal * value) / 100)
    if (coupon.maxDiscount != null && Number.isFinite(Number(coupon.maxDiscount))) {
      amount = Math.min(amount, Number(coupon.maxDiscount))
    }
  } else {
    amount = Math.min(value, eligibleSubtotal)
  }

  amount = Math.min(amount, eligibleSubtotal)
  return roundMoney(Math.max(0, amount))
}

async function countHeldRedemptions(couponId, { userId = null, excludeOrderId = null, session = null } = {}) {
  const filter = {
    couponId,
    status: { $in: ['RESERVED', 'REDEEMED'] },
  }
  if (userId) filter.userId = userId
  if (excludeOrderId) filter.orderId = { $ne: excludeOrderId }

  const query = CouponRedemption.countDocuments(filter)
  if (session) query.session(session)
  return query
}

/**
 * Atomically claim a global usage slot (usageCount + reservedCount < usageLimit).
 * Unlimited coupons skip the claim.
 */
async function claimUsageSlot(couponId, session = null) {
  const filter = {
    _id: couponId,
    enabled: true,
    archived: { $ne: true },
    $expr: {
      $or: [
        { $eq: ['$usageLimit', null] },
        {
          $lt: [
            { $add: [{ $ifNull: ['$usageCount', 0] }, { $ifNull: ['$reservedCount', 0] }] },
            '$usageLimit',
          ],
        },
      ],
    },
  }
  const update = { $inc: { reservedCount: 1 } }
  const opts = { returnDocument: 'after' }
  if (session) opts.session = session
  return Coupon.findOneAndUpdate(filter, update, opts)
}

async function releaseUsageSlot(couponId, session = null) {
  const update = Coupon.findOneAndUpdate(
    { _id: couponId, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1 } },
  )
  if (session) update.session(session)
  return update
}

/**
 * Validate a coupon against cart lines and return a quote.
 *
 * @param {object} options
 * @param {string} options.code
 * @param {Array} options.cartItems - raw cart items or resolved lines with productId/variantId/quantity
 * @param {string|null} options.userId
 * @param {Date} [options.now]
 * @param {import('mongoose').ClientSession|null} [options.session]
 * @param {string|null} [options.excludeOrderId] - ignore this order's RESERVED when counting limits
 * @param {boolean} [options.requireLoginForRestricted=true]
 */
export async function validateAndQuote({
  code,
  cartItems = [],
  userId = null,
  now = new Date(),
  session = null,
  excludeOrderId = null,
  requireLoginForRestricted = true,
} = {}) {
  const normalized = normalizeCouponCode(code)
  if (!normalized) return couponFailure(COUPON_ERROR.MISSING_CODE)

  const couponQuery = Coupon.findOne({ code: normalized })
  if (session) couponQuery.session(session)
  const coupon = await couponQuery
  if (!coupon) return couponFailure(COUPON_ERROR.NOT_FOUND)
  if (coupon.archived) return couponFailure(COUPON_ERROR.ARCHIVED)
  if (!coupon.enabled) return couponFailure(COUPON_ERROR.DISABLED)

  const status = deriveCouponStatus(coupon, now)
  if (status === 'scheduled') return couponFailure(COUPON_ERROR.SCHEDULED)
  if (status === 'expired') return couponFailure(COUPON_ERROR.EXPIRED)

  const { lines, fullSubtotal } = await resolveCartLines(cartItems, session)
  if (lines.length === 0) return couponFailure(COUPON_ERROR.EMPTY_CART)

  const eligibleLines = lines.filter((line) => lineIsEligible(line, coupon))
  const eligibleSubtotal = roundMoney(
    eligibleLines.reduce((sum, line) => sum + line.lineTotal, 0),
  )

  if (eligibleSubtotal <= 0) {
    return couponFailure(COUPON_ERROR.NO_ELIGIBLE_ITEMS)
  }

  const scoped =
    coupon.productScope === 'SELECTED' || coupon.categoryScope === 'SELECTED'
  const minCartBase = scoped ? eligibleSubtotal : fullSubtotal
  const minCartValue = Number(coupon.minCartValue) || 0
  if (minCartValue > 0 && minCartBase < minCartValue) {
    return couponFailure(COUPON_ERROR.MIN_CART, {
      minCartValue,
      currentValue: minCartBase,
    })
  }

  if (coupon.customerEligibility !== 'ALL') {
    if (!userId) {
      if (requireLoginForRestricted) {
        return couponFailure(COUPON_ERROR.LOGIN_REQUIRED)
      }
    } else {
      const hasPrior = await userHasPriorPurchase(userId, session)
      if (coupon.customerEligibility === 'NEW' && hasPrior) {
        return couponFailure(COUPON_ERROR.CUSTOMER_NEW_ONLY)
      }
      if (coupon.customerEligibility === 'EXISTING' && !hasPrior) {
        return couponFailure(COUPON_ERROR.CUSTOMER_EXISTING_ONLY)
      }
    }
  }

  if (coupon.usageLimit != null) {
    const counterHeld = (coupon.usageCount || 0) + (coupon.reservedCount || 0)
    if (counterHeld >= coupon.usageLimit) {
      return couponFailure(COUPON_ERROR.USAGE_LIMIT)
    }
    const held = await countHeldRedemptions(coupon._id, { excludeOrderId, session })
    if (held >= coupon.usageLimit) {
      return couponFailure(COUPON_ERROR.USAGE_LIMIT)
    }
  }

  if (coupon.perCustomerLimit != null) {
    if (!userId) {
      return couponFailure(COUPON_ERROR.LOGIN_REQUIRED)
    }
    const userHeld = await countHeldRedemptions(coupon._id, {
      userId,
      excludeOrderId,
      session,
    })
    if (userHeld >= coupon.perCustomerLimit) {
      return couponFailure(COUPON_ERROR.PER_CUSTOMER_LIMIT)
    }
  }

  const discountAmount = computeDiscountAmount(coupon, eligibleSubtotal)
  if (discountAmount <= 0) {
    return couponFailure(COUPON_ERROR.ZERO_DISCOUNT)
  }

  return {
    ok: true,
    quote: {
      couponId: coupon._id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      maxDiscount: coupon.maxDiscount,
      discountAmount,
      eligibleSubtotal,
      fullSubtotal,
      productScope: coupon.productScope,
      categoryScope: coupon.categoryScope,
      customerEligibility: coupon.customerEligibility,
      message: `Coupon ${coupon.code} applied — you save ₹${discountAmount.toFixed(2)}`,
    },
    coupon,
  }
}

/**
 * Public-safe applied coupon payload for cart responses.
 */
export function formatAppliedCoupon(quote) {
  if (!quote) return null
  return {
    code: quote.code,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
    maxDiscount: quote.maxDiscount ?? null,
    discountAmount: quote.discountAmount,
    eligibleSubtotal: quote.eligibleSubtotal,
    message: quote.message,
  }
}

export function buildOrderCouponSnapshot(quote) {
  if (!quote) return null
  return {
    couponId: quote.couponId,
    code: quote.code,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
    maxDiscount: quote.maxDiscount ?? null,
    discountAmount: quote.discountAmount,
    productScope: quote.productScope,
    customerEligibility: quote.customerEligibility,
  }
}

/**
 * Reserve redemption for an order (createOrder). Counts against usage limits until RELEASED/REDEEMED.
 */
export async function reserveCouponRedemption({
  quote,
  userId,
  orderId,
  session = null,
} = {}) {
  if (!quote?.couponId || !userId || !orderId) {
    throw new Error('reserveCouponRedemption requires quote, userId, and orderId')
  }

  const couponQuery = Coupon.findById(quote.couponId)
  if (session) couponQuery.session(session)
  const coupon = await couponQuery
  if (!coupon || !coupon.enabled || coupon.archived) {
    const err = new Error('Coupon is no longer available')
    err.code = COUPON_ERROR.DISABLED
    throw err
  }

  if (coupon.perCustomerLimit != null) {
    const userHeld = await countHeldRedemptions(coupon._id, {
      userId,
      excludeOrderId: orderId,
      session,
    })
    if (userHeld >= coupon.perCustomerLimit) {
      const err = new Error(couponErrorMessage(COUPON_ERROR.PER_CUSTOMER_LIMIT))
      err.code = COUPON_ERROR.PER_CUSTOMER_LIMIT
      throw err
    }
  }

  // Atomic global slot claim prevents concurrent oversell of usageLimit
  if (coupon.usageLimit != null) {
    const claimed = await claimUsageSlot(coupon._id, session)
    if (!claimed) {
      const err = new Error(couponErrorMessage(COUPON_ERROR.USAGE_LIMIT))
      err.code = COUPON_ERROR.USAGE_LIMIT
      throw err
    }
  }

  const doc = {
    couponId: quote.couponId,
    userId,
    orderId,
    code: quote.code,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
    discountAmount: quote.discountAmount,
    status: 'RESERVED',
  }

  try {
    if (session) {
      const created = await CouponRedemption.create([doc], { session })
      return created[0]
    }
    return await CouponRedemption.create(doc)
  } catch (err) {
    if (coupon.usageLimit != null) {
      await releaseUsageSlot(coupon._id, session).catch(() => {})
    }
    throw err
  }
}

/**
 * Mark redemption REDEEMED and increment coupon usageCount (payment success).
 */
export async function redeemCouponForOrder(orderId, session = null) {
  if (!orderId) return null

  const findQuery = CouponRedemption.findOne({
    orderId,
    status: { $in: ['RESERVED', 'REDEEMED'] },
  })
  if (session) findQuery.session(session)
  const redemption = await findQuery
  if (!redemption) return null
  if (redemption.status === 'REDEEMED') return redemption

  redemption.status = 'REDEEMED'
  await redemption.save(session ? { session } : undefined)

  const update = Coupon.findOneAndUpdate(
    { _id: redemption.couponId },
    {
      $inc: { usageCount: 1, reservedCount: -1 },
    },
  )
  if (session) update.session(session)
  await update

  // Clamp reservedCount floor at 0 if it drifted
  const clamp = Coupon.findOneAndUpdate(
    { _id: redemption.couponId, reservedCount: { $lt: 0 } },
    { $set: { reservedCount: 0 } },
  )
  if (session) clamp.session(session)
  await clamp

  return redemption
}

/**
 * Release a reserved redemption (payment failure / cancel).
 */
export async function releaseCouponForOrder(orderId, session = null) {
  if (!orderId) return null

  const filter = { orderId, status: 'RESERVED' }
  const findQuery = CouponRedemption.findOne(filter)
  if (session) findQuery.session(session)
  const redemption = await findQuery
  if (!redemption) return null

  redemption.status = 'RELEASED'
  await redemption.save(session ? { session } : undefined)
  await releaseUsageSlot(redemption.couponId, session)
  const clamp = Coupon.findOneAndUpdate(
    { _id: redemption.couponId, reservedCount: { $lt: 0 } },
    { $set: { reservedCount: 0 } },
  )
  if (session) clamp.session(session)
  await clamp
  return redemption
}

/**
 * List active coupons that may be relevant for the current cart/user (non-sensitive).
 */
export async function listAvailableCouponsForCart({ cartItems = [], userId = null, now = new Date() } = {}) {
  const coupons = await Coupon.find({
    enabled: true,
    archived: false,
    startAt: { $lte: now },
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .lean()

  const results = []
  for (const coupon of coupons) {
    if (coupon.customerEligibility !== 'ALL' && !userId) continue
    const result = await validateAndQuote({
      code: coupon.code,
      cartItems,
      userId,
      now,
      requireLoginForRestricted: true,
    })
    if (!result.ok) continue
    results.push({
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      maxDiscount: coupon.maxDiscount ?? null,
      minCartValue: coupon.minCartValue || 0,
      customerEligibility: coupon.customerEligibility,
      discountAmount: result.quote.discountAmount,
      message: result.quote.message,
      expiresAt: coupon.expiresAt,
    })
  }
  return results
}

export function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id)
}
