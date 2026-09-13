import mongoose from 'mongoose'

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product ID is required'],
    },
    variantId: {
      type: String,
      required: [true, 'Variant ID is required'],
      trim: true,
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
      max: [99, 'Quantity cannot exceed 99 units'],
      default: 1,
    },
  },
  { _id: true },
)

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true,
      index: true,
    },
    items: {
      type: [cartItemSchema],
      default: [],
    },
    appliedCouponCode: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

// Virtual alias for user
cartSchema.virtual('user')
  .get(function () {
    return this.userId
  })
  .set(function (val) {
    this.userId = val
  })

export const Cart = mongoose.model('Cart', cartSchema)
