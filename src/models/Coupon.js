import mongoose from 'mongoose'

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [40, 'Coupon code must not exceed 40 characters'],
      index: true,
    },
    discountType: {
      type: String,
      required: true,
      enum: {
        values: ['PERCENTAGE', 'FIXED'],
        message: '{VALUE} is not a valid discount type',
      },
    },
    discountValue: {
      type: Number,
      required: [true, 'Discount value is required'],
      min: [0.01, 'Discount value must be greater than 0'],
    },
    maxDiscount: {
      type: Number,
      default: null,
      min: [0, 'Maximum discount cannot be negative'],
    },
    minCartValue: {
      type: Number,
      default: 0,
      min: [0, 'Minimum cart value cannot be negative'],
    },
    productScope: {
      type: String,
      required: true,
      enum: {
        values: ['ALL', 'SELECTED'],
        message: '{VALUE} is not a valid product scope',
      },
      default: 'ALL',
    },
    productIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
    },
    categoryScope: {
      type: String,
      required: true,
      enum: {
        values: ['ALL', 'SELECTED'],
        message: '{VALUE} is not a valid category scope',
      },
      default: 'ALL',
    },
    categorySlugs: {
      type: [{ type: String, trim: true, lowercase: true }],
      default: [],
    },
    customerEligibility: {
      type: String,
      required: true,
      enum: {
        values: ['ALL', 'NEW', 'EXISTING'],
        message: '{VALUE} is not a valid customer eligibility',
      },
      default: 'ALL',
    },
    startAt: {
      type: Date,
      required: [true, 'Start date is required'],
      index: true,
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiry date is required'],
      index: true,
    },
    usageLimit: {
      type: Number,
      default: null,
      min: [1, 'Usage limit must be at least 1 when set'],
    },
    usageCount: {
      type: Number,
      default: 0,
      min: [0, 'Usage count cannot be negative'],
    },
    reservedCount: {
      type: Number,
      default: 0,
      min: [0, 'Reserved count cannot be negative'],
    },
    perCustomerLimit: {
      type: Number,
      default: null,
      min: [1, 'Per-customer limit must be at least 1 when set'],
    },
    enabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    archived: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
)

couponSchema.index({ enabled: 1, startAt: 1, expiresAt: 1 })
couponSchema.index({ productIds: 1 })
couponSchema.index({ categorySlugs: 1 })

export function normalizeCouponCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

export function deriveCouponStatus(coupon, reference = new Date()) {
  if (!coupon || coupon.archived || !coupon.enabled) return 'disabled'
  const now = reference instanceof Date ? reference : new Date(reference)
  if (coupon.startAt && now < new Date(coupon.startAt)) return 'scheduled'
  if (coupon.expiresAt && now > new Date(coupon.expiresAt)) return 'expired'
  return 'active'
}

export const Coupon = mongoose.model('Coupon', couponSchema)
