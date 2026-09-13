import mongoose from 'mongoose'

const shippingAddressSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Recipient name is required'], trim: true },
    phone: { type: String, required: [true, 'Contact phone is required'], trim: true },
    house: { type: String, default: '', trim: true },
    street: { type: String, required: [true, 'Street address is required'], trim: true },
    area: { type: String, default: '', trim: true },
    landmark: { type: String, default: '', trim: true },
    city: { type: String, required: [true, 'City is required'], trim: true },
    state: { type: String, required: [true, 'State is required'], trim: true },
    pin: { type: String, required: [true, 'PIN code is required'], trim: true },
    country: { type: String, default: 'India', trim: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    lines: { type: [String], default: [] },
  },
  { _id: false },
)

const orderItemSnapshotSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required'],
    },
    variantId: {
      type: String,
      required: [true, 'Variant ID is required'],
      trim: true,
    },
    productName: {
      type: String,
      required: [true, 'Product name snapshot is required'],
      trim: true,
    },
    variantLabel: {
      type: String,
      required: [true, 'Variant label snapshot is required'],
      trim: true,
    },
    weight: {
      type: String,
      default: '',
      trim: true,
    },
    sku: {
      type: String,
      required: [true, 'SKU snapshot is required'],
      trim: true,
    },
    unitPrice: {
      type: Number,
      required: [true, 'Unit price snapshot is required'],
      min: [0, 'Unit price cannot be negative'],
    },
    originalPrice: {
      type: Number,
      default: null,
      min: [0, 'Original price cannot be negative'],
    },
    discount: {
      type: Number,
      default: null,
      min: [0, 'Discount cannot be negative'],
      max: [100, 'Discount cannot exceed 100%'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },
    restoredQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Restored quantity cannot be negative'],
    },
    lineTotal: {
      type: Number,
      required: [true, 'Line total is required'],
      min: [0, 'Line total cannot be negative'],
    },
    image: {
      type: String,
      default: '',
      trim: true,
    },
    storefront: {
      type: String,
      enum: ['nutri-hub', 'self-care', ''],
      default: '',
    },
  },
  { _id: false },
)

const orderStatusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    cancelledBy: { type: String, default: null }, // 'admin' | 'customer' — only set on CANCELLED events
  },
  { _id: false },
)

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: [true, 'Order number is required'],
      unique: true,
      trim: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Customer user reference is required'],
      index: true,
    },
    customerName: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Customer email is required'],
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      required: [true, 'Customer contact phone is required'],
      trim: true,
    },
    shippingAddress: {
      type: shippingAddressSnapshotSchema,
      required: [true, 'Shipping address snapshot is required'],
    },
    items: {
      type: [orderItemSnapshotSchema],
      validate: [
        (items) => Array.isArray(items) && items.length > 0,
        'Order must contain at least one line item snapshot',
      ],
    },
    subtotal: {
      type: Number,
      required: [true, 'Subtotal is required'],
      min: [0, 'Subtotal cannot be negative'],
    },
    shippingFee: {
      type: Number,
      required: [true, 'Shipping fee is required'],
      default: 0,
      min: [0, 'Shipping fee cannot be negative'],
    },
    discount: {
      type: Number,
      required: [true, 'Discount is required'],
      default: 0,
      min: [0, 'Discount cannot be negative'],
    },
    coupon: {
      type: new mongoose.Schema(
        {
          couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
          code: { type: String, default: null, trim: true, uppercase: true },
          discountType: { type: String, enum: ['PERCENTAGE', 'FIXED', null], default: null },
          discountValue: { type: Number, default: null, min: 0 },
          maxDiscount: { type: Number, default: null, min: 0 },
          discountAmount: { type: Number, default: 0, min: 0 },
          productScope: { type: String, enum: ['ALL', 'SELECTED', null], default: null },
          customerEligibility: {
            type: String,
            enum: ['ALL', 'NEW', 'EXISTING', null],
            default: null,
          },
        },
        { _id: false },
      ),
      default: null,
    },
    totalAmount: {
      type: Number,
      required: [true, 'Total amount is required'],
      min: [0, 'Total amount cannot be negative'],
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: [
          'PENDING_PAYMENT',
          'CONFIRMED',
          'PROCESSING',
          'SHIPPED',
          'OUT_FOR_DELIVERY',
          'DELIVERED',
          'CANCELLED',
          'REQUIRES_RECONCILIATION',
        ],
        message: '{VALUE} is not a valid order status',
      },
      default: 'PENDING_PAYMENT',
      index: true,
    },
    expectedDeliveryDate: {
      type: Date,
      default: function () {
        return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      index: true,
    },
    paymentStatus: {
      type: String,
      required: true,
      enum: {
        values: ['PENDING', 'SUCCESS', 'PAID', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REQUIRES_RECONCILIATION'],
        message: '{VALUE} is not a valid payment status',
      },
      default: 'PENDING',
      index: true,
    },
    paymentMethod: {
      type: String,
      default: null,
    },
    paymentId: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
    inventoryDeducted: {
      type: Boolean,
      default: false,
    },
    inventoryRestored: {
      type: Boolean,
      default: false,
    },
    courier: {
      type: String,
      default: null,
    },
    trackingNumber: {
      type: String,
      default: null,
    },
    trackingUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: [2048, 'Tracking URL must not exceed 2048 characters'],
    },
    notes: {
      type: String,
      default: '',
    },
    history: {
      type: [orderStatusHistorySchema],
      default: () => [
        {
          status: 'PENDING_PAYMENT',
          at: new Date(),
          note: 'Order created',
        },
      ],
    },
  },
  {
    timestamps: true,
  },
)

// Virtuals for alias compatibility
orderSchema.virtual('shipping')
  .get(function () {
    return this.shippingFee
  })
  .set(function (val) {
    this.shippingFee = val
  })

orderSchema.virtual('grandTotal')
  .get(function () {
    return this.totalAmount
  })
  .set(function (val) {
    this.totalAmount = val
  })

orderSchema.virtual('totals').get(function () {
  return {
    subtotal: this.subtotal,
    discount: this.discount,
    shipping: this.shippingFee,
    grandTotal: this.totalAmount,
  }
})

orderSchema.index({ 'coupon.code': 1 })

export const Order = mongoose.model('Order', orderSchema)
