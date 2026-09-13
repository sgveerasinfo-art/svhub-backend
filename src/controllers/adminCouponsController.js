import mongoose from 'mongoose'
import { Coupon, normalizeCouponCode, deriveCouponStatus } from '../models/Coupon.js'
import { CouponRedemption } from '../models/CouponRedemption.js'
import { parseKolkataDateTime, toKolkataInputValue } from '../utils/heroCampaign.js'

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function parseOptionalNumber(value, { allowNull = true } = {}) {
  if (value === undefined) return undefined
  if (value === null || value === '') return allowNull ? null : undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return NaN
  return n
}

function parseObjectIdList(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((id) => String(id || '').trim()).filter((id) => mongoose.isValidObjectId(id)))]
}

function parseSlugList(raw) {
  if (!Array.isArray(raw)) return []
  return [
    ...new Set(
      raw
        .map((s) => String(s || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

function parseDateInput(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (value == null || value === '') return null
  return parseKolkataDateTime(value)
}

export function formatAdminCoupon(coupon, stats = null) {
  const status = deriveCouponStatus(coupon)
  return {
    id: String(coupon._id),
    _id: String(coupon._id),
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    maxDiscount: coupon.maxDiscount ?? null,
    minCartValue: coupon.minCartValue || 0,
    productScope: coupon.productScope || 'ALL',
    productIds: (coupon.productIds || []).map(String),
    categoryScope: coupon.categoryScope || 'ALL',
    categorySlugs: coupon.categorySlugs || [],
    customerEligibility: coupon.customerEligibility || 'ALL',
    startAt: coupon.startAt,
    expiresAt: coupon.expiresAt,
    startAtLocal: toKolkataInputValue(coupon.startAt),
    expiresAtLocal: toKolkataInputValue(coupon.expiresAt),
    usageLimit: coupon.usageLimit ?? null,
    usageCount: coupon.usageCount || 0,
    perCustomerLimit: coupon.perCustomerLimit ?? null,
    enabled: Boolean(coupon.enabled),
    archived: Boolean(coupon.archived),
    status,
    redeemedCount: stats?.redeemedCount ?? (coupon.usageCount || 0),
    totalDiscountGiven: stats?.totalDiscountGiven ?? 0,
    reservedCount: stats?.reservedCount ?? 0,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  }
}

async function getCouponStats(couponId) {
  const [redeemedAgg, reservedCount] = await Promise.all([
    CouponRedemption.aggregate([
      { $match: { couponId: new mongoose.Types.ObjectId(String(couponId)), status: 'REDEEMED' } },
      {
        $group: {
          _id: null,
          redeemedCount: { $sum: 1 },
          totalDiscountGiven: { $sum: '$discountAmount' },
        },
      },
    ]),
    CouponRedemption.countDocuments({ couponId, status: 'RESERVED' }),
  ])
  const row = redeemedAgg[0] || {}
  return {
    redeemedCount: row.redeemedCount || 0,
    totalDiscountGiven: roundMoney(row.totalDiscountGiven || 0),
    reservedCount,
  }
}

function validateCouponPayload(body, { partial = false } = {}) {
  const errors = []
  const data = {}

  if (!partial || body.code !== undefined) {
    const code = normalizeCouponCode(body.code)
    if (!code) errors.push({ field: 'code', message: 'Coupon code is required.' })
    else if (code.length > 40) errors.push({ field: 'code', message: 'Coupon code must be 40 characters or fewer.' })
    else data.code = code
  }

  if (!partial || body.discountType !== undefined) {
    const discountType = String(body.discountType || '').toUpperCase()
    if (discountType !== 'PERCENTAGE' && discountType !== 'FIXED') {
      errors.push({ field: 'discountType', message: 'Discount type must be PERCENTAGE or FIXED.' })
    } else {
      data.discountType = discountType
    }
  }

  if (!partial || body.discountValue !== undefined) {
    const discountValue = Number(body.discountValue)
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      errors.push({ field: 'discountValue', message: 'Discount value must be greater than 0.' })
    } else {
      data.discountValue = discountValue
    }
  }

  if (!partial || body.maxDiscount !== undefined) {
    const maxDiscount = parseOptionalNumber(body.maxDiscount)
    if (Number.isNaN(maxDiscount)) {
      errors.push({ field: 'maxDiscount', message: 'Max discount must be a number.' })
    } else {
      data.maxDiscount = maxDiscount
    }
  }

  if (!partial || body.minCartValue !== undefined) {
    const minCartValue = parseOptionalNumber(body.minCartValue, { allowNull: false })
    if (minCartValue === undefined) data.minCartValue = 0
    else if (Number.isNaN(minCartValue) || minCartValue < 0) {
      errors.push({ field: 'minCartValue', message: 'Minimum cart value cannot be negative.' })
    } else {
      data.minCartValue = minCartValue
    }
  }

  if (!partial || body.productScope !== undefined) {
    const productScope = String(body.productScope || 'ALL').toUpperCase()
    if (productScope !== 'ALL' && productScope !== 'SELECTED') {
      errors.push({ field: 'productScope', message: 'Product scope must be ALL or SELECTED.' })
    } else {
      data.productScope = productScope
    }
  }

  if (!partial || body.productIds !== undefined) {
    data.productIds = parseObjectIdList(body.productIds)
  }

  if (!partial || body.categoryScope !== undefined) {
    const categoryScope = String(body.categoryScope || 'ALL').toUpperCase()
    if (categoryScope !== 'ALL' && categoryScope !== 'SELECTED') {
      errors.push({ field: 'categoryScope', message: 'Category scope must be ALL or SELECTED.' })
    } else {
      data.categoryScope = categoryScope
    }
  }

  if (!partial || body.categorySlugs !== undefined) {
    data.categorySlugs = parseSlugList(body.categorySlugs)
  }

  if (!partial || body.customerEligibility !== undefined) {
    const customerEligibility = String(body.customerEligibility || 'ALL').toUpperCase()
    if (!['ALL', 'NEW', 'EXISTING'].includes(customerEligibility)) {
      errors.push({ field: 'customerEligibility', message: 'Customer eligibility must be ALL, NEW, or EXISTING.' })
    } else {
      data.customerEligibility = customerEligibility
    }
  }

  if (!partial || body.startAt !== undefined) {
    const startAt = parseDateInput(body.startAt)
    if (!startAt) errors.push({ field: 'startAt', message: 'A valid start date/time is required.' })
    else data.startAt = startAt
  }

  if (!partial || body.expiresAt !== undefined) {
    const expiresAt = parseDateInput(body.expiresAt)
    if (!expiresAt) errors.push({ field: 'expiresAt', message: 'A valid expiry date/time is required.' })
    else data.expiresAt = expiresAt
  }

  if (!partial || body.usageLimit !== undefined) {
    const usageLimit = parseOptionalNumber(body.usageLimit)
    if (Number.isNaN(usageLimit)) {
      errors.push({ field: 'usageLimit', message: 'Usage limit must be a number.' })
    } else if (usageLimit != null && usageLimit < 1) {
      errors.push({ field: 'usageLimit', message: 'Usage limit must be at least 1 when set.' })
    } else {
      data.usageLimit = usageLimit
    }
  }

  if (!partial || body.perCustomerLimit !== undefined) {
    const perCustomerLimit = parseOptionalNumber(body.perCustomerLimit)
    if (Number.isNaN(perCustomerLimit)) {
      errors.push({ field: 'perCustomerLimit', message: 'Per-customer limit must be a number.' })
    } else if (perCustomerLimit != null && perCustomerLimit < 1) {
      errors.push({ field: 'perCustomerLimit', message: 'Per-customer limit must be at least 1 when set.' })
    } else {
      data.perCustomerLimit = perCustomerLimit
    }
  }

  if (!partial || body.enabled !== undefined) {
    data.enabled = body.enabled !== false && body.enabled !== 'false'
  }

  if (!partial || body.archived !== undefined) {
    data.archived = body.archived === true || body.archived === 'true'
  }

  // Cross-field checks when both dates present
  const startAt = data.startAt
  const expiresAt = data.expiresAt
  if (startAt && expiresAt && expiresAt <= startAt) {
    errors.push({ field: 'expiresAt', message: 'Expiry must be after the start time.' })
  }

  const discountType = data.discountType
  const discountValue = data.discountValue
  if (discountType === 'PERCENTAGE' && discountValue != null && discountValue > 100) {
    errors.push({ field: 'discountValue', message: 'Percentage discount cannot exceed 100.' })
  }

  if (data.productScope === 'SELECTED' && Array.isArray(data.productIds) && data.productIds.length === 0) {
    errors.push({ field: 'productIds', message: 'Select at least one product when product scope is SELECTED.' })
  }
  if (data.categoryScope === 'SELECTED' && Array.isArray(data.categorySlugs) && data.categorySlugs.length === 0) {
    errors.push({ field: 'categorySlugs', message: 'Select at least one category when category scope is SELECTED.' })
  }

  // maxDiscount only meaningful for percentage; clear for FIXED unless explicitly set
  if (data.discountType === 'FIXED' && data.maxDiscount !== undefined) {
    data.maxDiscount = null
  }

  return { errors, data }
}

export async function getAdminCoupons(req, res, next) {
  try {
    const { search, status, enabled } = req.query
    const filter = {}

    if (search && typeof search === 'string' && search.trim()) {
      filter.code = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }

    if (enabled === 'true') filter.enabled = true
    if (enabled === 'false') filter.enabled = false
    if (req.query.archived === 'true') filter.archived = true
    else if (req.query.archived !== 'all') filter.archived = { $ne: true }

    let coupons = await Coupon.find(filter).sort({ createdAt: -1 }).lean()

    const now = new Date()
    if (status && status !== 'all') {
      coupons = coupons.filter((c) => deriveCouponStatus(c, now) === String(status).toLowerCase())
    }

    const formatted = await Promise.all(
      coupons.map(async (c) => {
        const stats = await getCouponStats(c._id)
        return formatAdminCoupon(c, stats)
      }),
    )

    res.json({ success: true, data: formatted })
  } catch (err) {
    next(err)
  }
}

export async function getAdminCouponById(req, res, next) {
  try {
    const id = String(req.params.id || '').trim()
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'invalid_id', message: 'Invalid coupon id.' },
      })
    }

    const coupon = await Coupon.findById(id).lean()
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'coupon_not_found', message: 'Coupon not found.' },
      })
    }

    const stats = await getCouponStats(coupon._id)
    const recentRedemptions = await CouponRedemption.find({
      couponId: coupon._id,
      status: 'REDEEMED',
    })
      .sort({ updatedAt: -1 })
      .limit(25)
      .lean()

    res.json({
      success: true,
      data: {
        ...formatAdminCoupon(coupon, stats),
        recentRedemptions: recentRedemptions.map((r) => ({
          id: String(r._id),
          orderId: String(r.orderId),
          userId: String(r.userId),
          code: r.code,
          discountAmount: r.discountAmount,
          status: r.status,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      },
    })
  } catch (err) {
    next(err)
  }
}

export async function createAdminCoupon(req, res, next) {
  try {
    const { errors, data } = validateCouponPayload(req.body || {}, { partial: false })
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'validation_error', message: errors[0].message, fields: errors },
      })
    }

    const existing = await Coupon.findOne({ code: data.code })
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'duplicate_code', message: `Coupon code "${data.code}" already exists.` },
      })
    }

    const coupon = await Coupon.create({
      ...data,
      maxDiscount: data.discountType === 'PERCENTAGE' ? data.maxDiscount ?? null : null,
      usageCount: 0,
      archived: false,
    })

    res.status(201).json({
      success: true,
      data: formatAdminCoupon(coupon, { redeemedCount: 0, totalDiscountGiven: 0, reservedCount: 0 }),
    })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: { code: 'duplicate_code', message: 'Coupon code already exists.' },
      })
    }
    next(err)
  }
}

export async function updateAdminCoupon(req, res, next) {
  try {
    const id = String(req.params.id || '').trim()
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'invalid_id', message: 'Invalid coupon id.' },
      })
    }

    const coupon = await Coupon.findById(id)
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'coupon_not_found', message: 'Coupon not found.' },
      })
    }

    const { errors, data } = validateCouponPayload(req.body || {}, { partial: true })
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'validation_error', message: errors[0].message, fields: errors },
      })
    }

    if (data.code && data.code !== coupon.code) {
      const redeemedCount = await CouponRedemption.countDocuments({
        couponId: coupon._id,
        status: 'REDEEMED',
      })
      if (redeemedCount > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'code_locked',
            message: 'Cannot change the code of a coupon that has already been redeemed.',
          },
        })
      }
      const conflict = await Coupon.findOne({ code: data.code, _id: { $ne: coupon._id } })
      if (conflict) {
        return res.status(409).json({
          success: false,
          error: { code: 'duplicate_code', message: `Coupon code "${data.code}" already exists.` },
        })
      }
    }

    // Merge dates for cross-check when only one is patched
    const nextStart = data.startAt ?? coupon.startAt
    const nextExpiry = data.expiresAt ?? coupon.expiresAt
    if (nextStart && nextExpiry && new Date(nextExpiry) <= new Date(nextStart)) {
      return res.status(400).json({
        success: false,
        error: { code: 'validation_error', message: 'Expiry must be after the start time.' },
      })
    }

    const nextType = data.discountType ?? coupon.discountType
    const nextValue = data.discountValue ?? coupon.discountValue
    if (nextType === 'PERCENTAGE' && nextValue > 100) {
      return res.status(400).json({
        success: false,
        error: { code: 'validation_error', message: 'Percentage discount cannot exceed 100.' },
      })
    }

    Object.assign(coupon, data)
    if (coupon.discountType === 'FIXED') coupon.maxDiscount = null
    await coupon.save()

    const stats = await getCouponStats(coupon._id)
    res.json({ success: true, data: formatAdminCoupon(coupon, stats) })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: { code: 'duplicate_code', message: 'Coupon code already exists.' },
      })
    }
    next(err)
  }
}

export async function disableAdminCoupon(req, res, next) {
  try {
    const id = String(req.params.id || '').trim()
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'invalid_id', message: 'Invalid coupon id.' },
      })
    }

    const coupon = await Coupon.findById(id)
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'coupon_not_found', message: 'Coupon not found.' },
      })
    }

    coupon.enabled = false
    await coupon.save()
    const stats = await getCouponStats(coupon._id)
    res.json({ success: true, data: formatAdminCoupon(coupon, stats) })
  } catch (err) {
    next(err)
  }
}

export async function archiveAdminCoupon(req, res, next) {
  try {
    const id = String(req.params.id || '').trim()
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'invalid_id', message: 'Invalid coupon id.' },
      })
    }

    const coupon = await Coupon.findById(id)
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'coupon_not_found', message: 'Coupon not found.' },
      })
    }

    const held = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      status: { $in: ['RESERVED', 'REDEEMED'] },
    })

    // Soft-archive always; never hard-delete used coupons
    coupon.archived = true
    coupon.enabled = false
    await coupon.save()

    const stats = await getCouponStats(coupon._id)
    res.json({
      success: true,
      data: formatAdminCoupon(coupon, stats),
      message:
        held > 0
          ? 'Coupon archived (kept for order history).'
          : 'Coupon archived.',
    })
  } catch (err) {
    next(err)
  }
}
