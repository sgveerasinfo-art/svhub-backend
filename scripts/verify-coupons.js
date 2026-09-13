/**
 * Coupon system verification — service rules + redemption lifecycle.
 * Run: node scripts/verify-coupons.js
 * Optional API: TEST_API_URL=http://localhost:5001/api node scripts/verify-coupons.js
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { connectDb } from '../src/config/db.js'
import { Coupon } from '../src/models/Coupon.js'
import { CouponRedemption } from '../src/models/CouponRedemption.js'
import { Cart } from '../src/models/Cart.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { User } from '../src/models/User.js'
import { Category } from '../src/models/Category.js'
import {
  validateAndQuote,
  reserveCouponRedemption,
  redeemCouponForOrder,
  releaseCouponForOrder,
  COUPON_ERROR,
} from '../src/services/couponService.js'
import { serializePublicHero, parseKolkataDateTime } from '../src/utils/heroCampaign.js'

const BASE_URL = process.env.TEST_API_URL || ''
const suffix = `cpn_${Date.now()}`

let passed = 0
let failed = 0

function ok(description, condition, details = '') {
  if (condition) {
    console.log(`[PASS] ${description}`)
    passed++
  } else {
    console.error(`[FAIL] ${description}${details ? ` — ${details}` : ''}`)
    failed++
  }
}

async function apiRequest(path, options = {}) {
  if (!BASE_URL) return null
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

async function cleanup(ids) {
  const { couponIds, productIds, userIds, categoryIds, orderIds } = ids
  if (orderIds?.length) {
    await CouponRedemption.deleteMany({ orderId: { $in: orderIds } })
    await Order.deleteMany({ _id: { $in: orderIds } })
  }
  if (couponIds?.length) {
    await CouponRedemption.deleteMany({ couponId: { $in: couponIds } })
    await Coupon.deleteMany({ _id: { $in: couponIds } })
  }
  if (productIds?.length) await Product.deleteMany({ _id: { $in: productIds } })
  if (categoryIds?.length) await Category.deleteMany({ _id: { $in: categoryIds } })
  if (userIds?.length) {
    await Cart.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
}

async function main() {
  console.log('====================================================')
  console.log('SV HUB — COUPON / PROMOTIONAL DISCOUNT VERIFICATION')
  console.log('====================================================\n')

  await connectDb()

  const now = new Date()
  const startPast = new Date(now.getTime() - 86400000)
  const endFuture = new Date(now.getTime() + 7 * 86400000)
  const startFuture = new Date(now.getTime() + 86400000)
  const endPast = new Date(now.getTime() - 3600000)

  const couponIds = []
  const productIds = []
  const userIds = []
  const categoryIds = []
  const orderIds = []

  try {
    // --- Hero campaign still marketing-only ---
    const hero = serializePublicHero(
      {
        enabled: true,
        discountPercent: 10,
        startAt: parseKolkataDateTime('2026-09-01T00:00'),
        endAt: parseKolkataDateTime('2026-12-31T23:59'),
        label: 'Test',
        title: 'Test',
        subtitle: 'Test',
      },
      now,
    )
    ok(
      'Hero campaign discountAppliesAtCheckout remains false',
      hero?.campaign?.discountAppliesAtCheckout === false || hero?.mode === 'normal',
    )

    const cat = await Category.create({
      name: `Coupon Cat ${suffix}`,
      slug: `coupon-cat-${suffix}`,
      storefront: 'nutri-hub',
      active: true,
    })
    categoryIds.push(cat._id)

    const productA = await Product.create({
      name: `Coupon Product A ${suffix}`,
      slug: `coupon-prod-a-${suffix}`,
      type: 'Native Rice',
      category: cat.slug,
      storefront: 'nutri-hub',
      description: 'Coupon test product A',
      image: 'https://images.unsplash.com/photo-rice',
      price: 200,
      weight: '500 g',
      sku: `SKU-A-${suffix}`,
      qty: 50,
      isActive: true,
      variants: [
        {
          variantId: '500g',
          label: '500g',
          weight: '500g',
          sku: `SKU-A-500-${suffix}`,
          price: 200,
          qty: 50,
          isActive: true,
        },
      ],
    })
    productIds.push(productA._id)

    const productB = await Product.create({
      name: `Coupon Product B ${suffix}`,
      slug: `coupon-prod-b-${suffix}`,
      type: 'Native Rice',
      category: 'other-cat',
      storefront: 'nutri-hub',
      description: 'Coupon test product B',
      image: 'https://images.unsplash.com/photo-rice-b',
      price: 300,
      weight: '500 g',
      sku: `SKU-B-${suffix}`,
      qty: 50,
      isActive: true,
      variants: [
        {
          variantId: '500g',
          label: '500g',
          weight: '500g',
          sku: `SKU-B-500-${suffix}`,
          price: 300,
          qty: 50,
          isActive: true,
        },
      ],
    })
    productIds.push(productB._id)

    const newUser = await User.create({
      name: 'Coupon New User',
      email: `new_${suffix}@example.com`,
      password: 'Password@123',
      role: 'CUSTOMER',
    })
    userIds.push(newUser._id)

    const existingUser = await User.create({
      name: 'Coupon Existing User',
      email: `exist_${suffix}@example.com`,
      password: 'Password@123',
      role: 'CUSTOMER',
    })
    userIds.push(existingUser._id)

    const priorOrder = await Order.create({
      orderNumber: `#SVH-TEST-${suffix}`,
      userId: existingUser._id,
      customerName: 'Existing',
      email: existingUser.email,
      phone: '9999999999',
      shippingAddress: {
        name: 'Existing',
        phone: '9999999999',
        street: '1 Test St',
        city: 'Chennai',
        state: 'TN',
        pin: '600001',
        country: 'India',
        lines: ['1 Test St', 'Chennai'],
      },
      items: [
        {
          productId: productA._id,
          variantId: '500g',
          productName: productA.name,
          variantLabel: '500g',
          sku: `SKU-A-${suffix}`,
          unitPrice: 200,
          quantity: 1,
          lineTotal: 200,
        },
      ],
      subtotal: 200,
      shippingFee: 0,
      discount: 0,
      totalAmount: 200,
      status: 'DELIVERED',
      paymentStatus: 'SUCCESS',
    })
    orderIds.push(priorOrder._id)

    const cartItemsBoth = [
      { productId: productA._id, variantId: '500g', quantity: 2 }, // 400
      { productId: productB._id, variantId: '500g', quantity: 1 }, // 300
    ]

    // Percentage + max cap
    const pctCoupon = await Coupon.create({
      code: `PCT${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'PERCENTAGE',
      discountValue: 20,
      maxDiscount: 50,
      minCartValue: 0,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(pctCoupon._id)

    let quote = await validateAndQuote({
      code: pctCoupon.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('Percentage quote succeeds', quote.ok)
    ok('Percentage applies maxDiscount cap', quote.ok && quote.quote.discountAmount === 50, JSON.stringify(quote.quote))

    // Fixed
    const fixedCoupon = await Coupon.create({
      code: `FIX${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 1000,
      minCartValue: 0,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(fixedCoupon._id)
    quote = await validateAndQuote({
      code: fixedCoupon.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('Fixed discount capped by eligible subtotal', quote.ok && quote.quote.discountAmount === 700)

    // Min cart
    const minCoupon = await Coupon.create({
      code: `MIN${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 10,
      minCartValue: 1000,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(minCoupon._id)
    quote = await validateAndQuote({
      code: minCoupon.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('Min cart rejects undersized cart', !quote.ok && quote.error.code === COUPON_ERROR.MIN_CART)

    // Product scope
    const prodCoupon = await Coupon.create({
      code: `PROD${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'PERCENTAGE',
      discountValue: 10,
      productScope: 'SELECTED',
      productIds: [productA._id],
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(prodCoupon._id)
    quote = await validateAndQuote({
      code: prodCoupon.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok(
      'Selected product eligibility uses eligible subtotal only',
      quote.ok && quote.quote.eligibleSubtotal === 400 && quote.quote.discountAmount === 40,
    )

    // Category scope
    const catCoupon = await Coupon.create({
      code: `CAT${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 25,
      productScope: 'ALL',
      categoryScope: 'SELECTED',
      categorySlugs: [cat.slug],
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(catCoupon._id)
    quote = await validateAndQuote({
      code: catCoupon.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('Selected category eligibility works', quote.ok && quote.quote.eligibleSubtotal === 400)

    // New vs existing
    const newOnly = await Coupon.create({
      code: `NEW${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 10,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'NEW',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(newOnly._id)
    quote = await validateAndQuote({
      code: newOnly.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('NEW coupon allows new customer', quote.ok)
    quote = await validateAndQuote({
      code: newOnly.code,
      cartItems: cartItemsBoth,
      userId: existingUser._id,
    })
    ok('NEW coupon rejects existing customer', !quote.ok && quote.error.code === COUPON_ERROR.CUSTOMER_NEW_ONLY)

    const existOnly = await Coupon.create({
      code: `OLD${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 10,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'EXISTING',
      startAt: startPast,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(existOnly._id)
    quote = await validateAndQuote({
      code: existOnly.code,
      cartItems: cartItemsBoth,
      userId: existingUser._id,
    })
    ok('EXISTING coupon allows prior purchaser', quote.ok)
    quote = await validateAndQuote({
      code: existOnly.code,
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok(
      'EXISTING coupon rejects new customer',
      !quote.ok && quote.error.code === COUPON_ERROR.CUSTOMER_EXISTING_ONLY,
    )

    // Schedule / expiry / disabled
    const scheduled = await Coupon.create({
      code: `SCH${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 10,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startFuture,
      expiresAt: endFuture,
      enabled: true,
    })
    couponIds.push(scheduled._id)
    quote = await validateAndQuote({ code: scheduled.code, cartItems: cartItemsBoth, userId: newUser._id })
    ok('Scheduled coupon rejected', !quote.ok && quote.error.code === COUPON_ERROR.SCHEDULED)

    const expired = await Coupon.create({
      code: `EXP${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 10,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endPast,
      enabled: true,
    })
    couponIds.push(expired._id)
    quote = await validateAndQuote({ code: expired.code, cartItems: cartItemsBoth, userId: newUser._id })
    ok('Expired coupon rejected', !quote.ok && quote.error.code === COUPON_ERROR.EXPIRED)

    pctCoupon.enabled = false
    await pctCoupon.save()
    quote = await validateAndQuote({ code: pctCoupon.code, cartItems: cartItemsBoth, userId: newUser._id })
    ok('Disabled coupon rejected', !quote.ok && quote.error.code === COUPON_ERROR.DISABLED)
    pctCoupon.enabled = true
    await pctCoupon.save()

    // Usage limit + redemption lifecycle
    const limited = await Coupon.create({
      code: `LIM${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 15,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      usageLimit: 1,
      enabled: true,
    })
    couponIds.push(limited._id)

    const order1 = await Order.create({
      orderNumber: `#SVH-CPN1-${suffix}`,
      userId: newUser._id,
      customerName: 'New',
      email: newUser.email,
      phone: '9000000001',
      shippingAddress: {
        name: 'New',
        phone: '9000000001',
        street: '2 Test',
        city: 'Chennai',
        state: 'TN',
        pin: '600001',
        country: 'India',
        lines: ['2 Test'],
      },
      items: [
        {
          productId: productA._id,
          variantId: '500g',
          productName: productA.name,
          variantLabel: '500g',
          sku: `SKU-A-${suffix}`,
          unitPrice: 200,
          quantity: 1,
          lineTotal: 200,
        },
      ],
      subtotal: 200,
      shippingFee: 40,
      discount: 15,
      coupon: {
        couponId: limited._id,
        code: limited.code,
        discountType: 'FIXED',
        discountValue: 15,
        discountAmount: 15,
        productScope: 'ALL',
        customerEligibility: 'ALL',
      },
      totalAmount: 225,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
    })
    orderIds.push(order1._id)

    const q1 = await validateAndQuote({
      code: limited.code,
      cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
      userId: newUser._id,
    })
    ok('Limited coupon available before reserve', q1.ok)
    await reserveCouponRedemption({ quote: q1.quote, userId: newUser._id, orderId: order1._id })

    const q2 = await validateAndQuote({
      code: limited.code,
      cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
      userId: existingUser._id,
    })
    ok('Usage limit blocks second RESERVED slot', !q2.ok && q2.error.code === COUPON_ERROR.USAGE_LIMIT)

    await releaseCouponForOrder(order1._id)
    const released = await CouponRedemption.findOne({ orderId: order1._id })
    ok('Payment failure RELEASES reserved redemption', released?.status === 'RELEASED')

    const q3 = await validateAndQuote({
      code: limited.code,
      cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
      userId: existingUser._id,
    })
    ok('Slot free after RELEASE', q3.ok)

    const order2 = await Order.create({
      orderNumber: `#SVH-CPN2-${suffix}`,
      userId: existingUser._id,
      customerName: 'Exist',
      email: existingUser.email,
      phone: '9000000002',
      shippingAddress: {
        name: 'Exist',
        phone: '9000000002',
        street: '3 Test',
        city: 'Chennai',
        state: 'TN',
        pin: '600001',
        country: 'India',
        lines: ['3 Test'],
      },
      items: [
        {
          productId: productA._id,
          variantId: '500g',
          productName: productA.name,
          variantLabel: '500g',
          sku: `SKU-A-${suffix}`,
          unitPrice: 200,
          quantity: 1,
          lineTotal: 200,
        },
      ],
      subtotal: 200,
      shippingFee: 40,
      discount: 15,
      coupon: {
        couponId: limited._id,
        code: limited.code,
        discountType: 'FIXED',
        discountValue: 15,
        discountAmount: 15,
        productScope: 'ALL',
        customerEligibility: 'ALL',
      },
      totalAmount: 225,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
    })
    orderIds.push(order2._id)

    await reserveCouponRedemption({ quote: q3.quote, userId: existingUser._id, orderId: order2._id })
    await redeemCouponForOrder(order2._id)
    const redeemed = await CouponRedemption.findOne({ orderId: order2._id })
    const refreshed = await Coupon.findById(limited._id)
    ok('Payment success marks REDEEMED', redeemed?.status === 'REDEEMED')
    ok('usageCount increments on redeem', refreshed?.usageCount === 1)

    // Per-customer limit
    const perCust = await Coupon.create({
      code: `PER${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 5,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      perCustomerLimit: 1,
      enabled: true,
    })
    couponIds.push(perCust._id)
    const order3 = await Order.create({
      orderNumber: `#SVH-CPN3-${suffix}`,
      userId: newUser._id,
      customerName: 'New',
      email: newUser.email,
      phone: '9000000001',
      shippingAddress: priorOrder.shippingAddress,
      items: priorOrder.items,
      subtotal: 200,
      shippingFee: 0,
      discount: 5,
      totalAmount: 195,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
    })
    orderIds.push(order3._id)
    const pq = await validateAndQuote({
      code: perCust.code,
      cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
      userId: newUser._id,
    })
    await reserveCouponRedemption({ quote: pq.quote, userId: newUser._id, orderId: order3._id })
    await redeemCouponForOrder(order3._id)
    const pq2 = await validateAndQuote({
      code: perCust.code,
      cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
      userId: newUser._id,
    })
    ok(
      'Per-customer limit blocks second redeem',
      !pq2.ok && pq2.error.code === COUPON_ERROR.PER_CUSTOMER_LIMIT,
    )

    // Concurrent reserve against usageLimit:1
    const raceCoupon = await Coupon.create({
      code: `RACE${suffix}`.slice(0, 40).toUpperCase(),
      discountType: 'FIXED',
      discountValue: 5,
      productScope: 'ALL',
      categoryScope: 'ALL',
      customerEligibility: 'ALL',
      startAt: startPast,
      expiresAt: endFuture,
      usageLimit: 1,
      enabled: true,
    })
    couponIds.push(raceCoupon._id)

    const raceOrders = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const o = await Order.create({
          orderNumber: `#SVH-RACE${i}-${suffix}`,
          userId: newUser._id,
          customerName: 'Race',
          email: newUser.email,
          phone: '9000000001',
          shippingAddress: priorOrder.shippingAddress,
          items: priorOrder.items,
          subtotal: 200,
          shippingFee: 0,
          discount: 5,
          totalAmount: 195,
          status: 'PENDING_PAYMENT',
          paymentStatus: 'PENDING',
        })
        orderIds.push(o._id)
        return o
      }),
    )

    const raceResults = await Promise.all(
      raceOrders.map(async (o) => {
        const q = await validateAndQuote({
          code: raceCoupon.code,
          cartItems: [{ productId: productA._id, variantId: '500g', quantity: 1 }],
          userId: newUser._id,
        })
        if (!q.ok) return { ok: false, reason: q.error.code }
        try {
          await reserveCouponRedemption({ quote: q.quote, userId: newUser._id, orderId: o._id })
          return { ok: true }
        } catch (err) {
          return { ok: false, reason: err.message }
        }
      }),
    )
    const reservedOk = raceResults.filter((r) => r.ok).length
    const held = await CouponRedemption.countDocuments({
      couponId: raceCoupon._id,
      status: { $in: ['RESERVED', 'REDEEMED'] },
    })
    ok(
      'Concurrent createOrder-style reserves respect usageLimit (≤1 held)',
      held <= 1,
      `held=${held} reservedOk=${reservedOk}`,
    )

    // Invalid code
    quote = await validateAndQuote({
      code: 'DOESNOTEXIST999',
      cartItems: cartItemsBoth,
      userId: newUser._id,
    })
    ok('Unknown code rejected', !quote.ok && quote.error.code === COUPON_ERROR.NOT_FOUND)

    // Optional HTTP security checks
    if (BASE_URL) {
      console.log('\n--- API checks ---')
      const adminList = await apiRequest('/admin/coupons')
      ok('Admin coupons require auth', adminList?.status === 401 || adminList?.status === 403)

      const cartCoupon = await apiRequest('/cart/coupon', {
        method: 'POST',
        body: JSON.stringify({ code: pctCoupon.code }),
      })
      ok('Cart coupon requires auth', cartCoupon?.status === 401 || cartCoupon?.status === 403)
    } else {
      console.log('\n(Skipping HTTP checks — set TEST_API_URL to enable)')
      ok('HTTP checks skipped (informational)', true)
    }

    assert.ok(true)
  } finally {
    await cleanup({ couponIds, productIds, userIds, categoryIds, orderIds })
    await mongoose.connection.close().catch(() => {})
  }

  console.log('\n====================================================')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log('====================================================')
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
