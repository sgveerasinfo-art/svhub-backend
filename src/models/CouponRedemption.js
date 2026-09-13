import mongoose from 'mongoose'

const couponRedemptionSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coupon',
      required: [true, 'Coupon reference is required'],
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: [true, 'Order reference is required'],
      unique: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    discountType: {
      type: String,
      required: true,
      enum: ['PERCENTAGE', 'FIXED'],
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: ['RESERVED', 'REDEEMED', 'RELEASED'],
        message: '{VALUE} is not a valid redemption status',
      },
      default: 'RESERVED',
      index: true,
    },
  },
  {
    timestamps: true,
  },
)

couponRedemptionSchema.index({ couponId: 1, userId: 1, status: 1 })
couponRedemptionSchema.index({ couponId: 1, status: 1 })

export const CouponRedemption = mongoose.model('CouponRedemption', couponRedemptionSchema)
