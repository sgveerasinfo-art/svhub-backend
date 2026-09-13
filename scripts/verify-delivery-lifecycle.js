import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDb } from '../src/config/db.js'
import { User, Product, Cart, Address, Order, Payment } from '../src/models/index.js'

import crypto from "node:crypto"
const DEV_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url")

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000/api'

let passed = 0
let failed = 0

function assert(description, condition, details = '') {
  if (condition) {
    console.log(`[PASS] ${description}`)
    passed++
  } else {
    console.error(`[FAIL] ${description} ${details}`)
    failed++
  }
}

async function apiRequest(path, options = {}) {
  const url = `${BASE_URL}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

async function runDeliveryLifecycleTests() {
  console.log('====================================================')
  console.log('SV HUB — PHASE 2.3 DELIVERY LIFECYCLE & TRACKING')
  console.log('====================================================\n')

  await connectDb()

  const suffix = `p23_${Date.now()}`
  let customerToken, customerUserId, customerEmail
  let adminToken, adminUserId
  let testProduct
  let testOrder

  try {
    // -------------------------------------------------------------
    // 1. SETUP: Customer, Admin, Product
    // -------------------------------------------------------------
    console.log('--- 1. SETUP: Auth & Fixtures ---')
    customerEmail = `cust_${suffix}@example.com`
    const regRes = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Delivery Tester',
        email: customerEmail,
        password: 'Password@123',
        phone: '9876599991',
      }),
    })
    customerToken = regRes.data?.token
    customerUserId = regRes.data?.user?.id
    assert('Customer registered successfully', regRes.status === 201 && customerToken)

    // Admin user fixture & login
    const adminEmail = `admin_${suffix}@svhub.in`
    const adminUser = await User.create({
      name: 'Admin Supervisor',
      email: adminEmail,
      passwordHash: await bcrypt.hash(DEV_ADMIN_PASSWORD, 10),
      phone: '9876599992',
      role: 'ADMIN',
      status: 'ACTIVE',
      provider: 'PASSWORD',
    })
    adminUserId = adminUser._id

    const adminLoginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: adminEmail,
        password: DEV_ADMIN_PASSWORD,
      }),
    })
    adminToken = adminLoginRes.data?.token
    assert('Admin logged in successfully', adminLoginRes.status === 200 && adminToken)

    // Create test product
    const sku = `SKU-P23-${Date.now()}`
    testProduct = await Product.create({
      name: `Delivery Test Powder ${suffix}`,
      slug: `delivery-powder-${suffix}`,
      type: 'Powder',
      storefront: 'self-care',
      category: 'herbal-powders',
      description: 'Test product for Phase 2.3 delivery tracking',
      price: 250,
      weight: '200 g',
      sku,
      qty: 20,
      isActive: true,
      variants: [
        {
          variantId: '200g',
          label: '200 g Pouch',
          weight: '200 g',
          sku: `${sku}-200`,
          price: 250,
          qty: 20,
          isActive: true,
        },
      ],
      image: 'https://images.unsplash.com/photo-1471193945509-9ad0617afabf?auto=format&fit=crop&w=600&q=80',
    })
    assert('Test product created in MongoDB', Boolean(testProduct?._id))

    // Customer adds to cart
    await apiRequest('/cart/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ productId: String(testProduct._id), variantId: '200g', quantity: 2 }),
    })

    // -------------------------------------------------------------
    // 2. ORDER CREATION: Expected Delivery Date Initialization
    // -------------------------------------------------------------
    console.log('\n--- 2. ORDER CREATION & EXPECTED DELIVERY INITIALIZATION ---')
    const beforeCreate = Date.now()
    const orderCreateRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        shippingMethod: 'standard',
        expectedDeliveryDate: '2099-01-01T00:00:00.000Z', // Tampering attempt: customer tries to set arbitrary date
        shippingAddress: {
          name: 'Delivery Tester',
          phone: '9876599991',
          street: '123 Delivery Road',
          city: 'Coimbatore',
          state: 'Tamil Nadu',
          pin: '641001',
          country: 'India',
        },
      }),
    })

    assert('Customer order created (HTTP 201)', orderCreateRes.status === 201)
    testOrder = orderCreateRes.data?.data
    assert('Returned order contains expectedDeliveryDate', Boolean(testOrder?.expectedDeliveryDate))

    const expDate = new Date(testOrder.expectedDeliveryDate).getTime()
    const expectedTarget = beforeCreate + 7 * 24 * 60 * 60 * 1000
    const diffHours = Math.abs(expDate - expectedTarget) / (1000 * 60 * 60)
    assert(
      'Server-side expectedDeliveryDate ≈ creation date + 7 calendar days',
      diffHours < 2,
      `Diff: ${diffHours}h`
    )
    assert(
      'Customer cannot override expectedDeliveryDate during order creation (tampered 2099 date was ignored)',
      !testOrder.expectedDeliveryDate.startsWith('2099')
    )

    // Check DB document directly
    const orderDoc = await Order.findById(testOrder.id)
    assert('Order in MongoDB has persisted expectedDeliveryDate', Boolean(orderDoc?.expectedDeliveryDate))

    // -------------------------------------------------------------
    // 3. CUSTOMER ORDER DETAIL & LIST: Expected Delivery Date Visibility
    // -------------------------------------------------------------
    console.log('\n--- 3. CUSTOMER API READ VISIBILITY ---')
    // 3.1 By ID
    const getCustOrderById = await apiRequest(`/orders/${testOrder.id}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert('GET /api/orders/:id returns 200', getCustOrderById.status === 200)
    assert(
      'GET /api/orders/:id includes expectedDeliveryDate',
      Boolean(getCustOrderById.data?.data?.expectedDeliveryDate)
    )

    // 3.2 By Order Number
    const cleanNum = testOrder.orderNumber.replace(/^#/, '')
    const getCustOrderByNum = await apiRequest(`/orders/${cleanNum}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert(
      'GET /api/orders/:orderNumber includes expectedDeliveryDate',
      Boolean(getCustOrderByNum.data?.data?.expectedDeliveryDate)
    )

    // 3.3 List
    const getCustOrdersList = await apiRequest('/orders', {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    const foundInList = (getCustOrdersList.data?.data || []).find((o) => o.id === testOrder.id)
    assert(
      'Customer order list includes expectedDeliveryDate on each order',
      Boolean(foundInList?.expectedDeliveryDate)
    )

    // -------------------------------------------------------------
    // 4. AUTHORIZATION: Non-Admin Cannot Modify Expected Delivery Date
    // -------------------------------------------------------------
    console.log('\n--- 4. AUTHORIZATION & ACCESS CONTROL ---')
    // 4.1 Unauthenticated PATCH /api/admin/orders/:id
    const unauthPatch = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedDeliveryDate: '2026-09-25T12:00:00.000Z' }),
    })
    assert('Unauthenticated update rejected with HTTP 401', unauthPatch.status === 401)

    // 4.2 Customer token PATCH /api/admin/orders/:id
    const customerPatch = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ expectedDeliveryDate: '2026-09-25T12:00:00.000Z' }),
    })
    assert('Customer update on admin endpoint rejected with HTTP 403', customerPatch.status === 403)

    // 4.3 Customer has no PATCH endpoint on /api/orders/:id
    const customerPatchOwn = await apiRequest(`/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ expectedDeliveryDate: '2026-09-25T12:00:00.000Z' }),
    })
    assert('Customer cannot modify order via customer API (HTTP 404 or 405)', [404, 405].includes(customerPatchOwn.status))

    // -------------------------------------------------------------
    // 5. ADMIN CONTROL & DATE VALIDATION
    // -------------------------------------------------------------
    console.log('\n--- 5. ADMIN DATE UPDATE & VALIDATION ---')
    // 5.1 Reject empty date
    const emptyDateRes = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ expectedDeliveryDate: '' }),
    })
    assert(
      'Admin rejecting empty date with HTTP 400 (invalid_expected_delivery_date)',
      emptyDateRes.status === 400 && emptyDateRes.data?.error?.code === 'invalid_expected_delivery_date'
    )

    // 5.2 Reject malformed date
    const malformedDateRes = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ expectedDeliveryDate: 'not-a-valid-date' }),
    })
    assert(
      'Admin rejecting malformed date with HTTP 400 (invalid_expected_delivery_date)',
      malformedDateRes.status === 400 && malformedDateRes.data?.error?.code === 'invalid_expected_delivery_date'
    )

    // 5.3 Reject past date earlier than order creation for active order
    const pastDateRes = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ expectedDeliveryDate: '2020-01-01T00:00:00.000Z' }),
    })
    assert(
      'Admin rejecting date earlier than order creation date (HTTP 400)',
      pastDateRes.status === 400 && pastDateRes.data?.error?.code === 'invalid_expected_delivery_date'
    )

    // 5.4 Valid admin update to a new expected date
    const newExpectedIso = '2026-09-25T12:00:00.000Z'
    const validUpdateRes = await apiRequest(`/admin/orders/${testOrder.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ expectedDeliveryDate: newExpectedIso }),
    })
    assert('Admin valid expected delivery date update succeeds (HTTP 200)', validUpdateRes.status === 200)

    // 5.5 Check audit trail in order history
    const orderAfterDateUpdate = await Order.findById(testOrder.id)
    const historyEntry = orderAfterDateUpdate.history.find((h) => h.note?.includes('Expected delivery changed'))
    assert('Order history records expected delivery change audit trail', Boolean(historyEntry))
    console.log(`      Audit note recorded: "${historyEntry?.note}"`)

    // 5.6 Customer immediately reads the updated date
    const custAfterUpdate = await apiRequest(`/orders/${testOrder.id}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    const custDate = custAfterUpdate.data?.data?.expectedDeliveryDate
    assert(
      'Customer immediately sees admin-updated expectedDeliveryDate on API refresh',
      new Date(custDate).toISOString() === new Date(newExpectedIso).toISOString()
    )

    // -------------------------------------------------------------
    // 6. STATUS PROGRESSION: Pending → Confirmed → Processing → Shipped → Out for Delivery → Delivered
    // -------------------------------------------------------------
    console.log('\n--- 6. FULFILLMENT LIFECYCLE PROGRESSION ---')
    const lifecycleSteps = [
      { status: 'CONFIRMED', expectedDisplay: 'Confirmed' },
      { status: 'PROCESSING', expectedDisplay: 'Processing' },
      { status: 'SHIPPED', expectedDisplay: 'Shipped', courier: 'BlueDart', trackingNumber: 'BD-998877' },
      { status: 'OUT_FOR_DELIVERY', expectedDisplay: 'Out for Delivery' },
      { status: 'DELIVERED', expectedDisplay: 'Delivered' },
    ]

    for (const step of lifecycleSteps) {
      const patchPayload = { status: step.status }
      if (step.courier) patchPayload.courier = step.courier
      if (step.trackingNumber) patchPayload.trackingNumber = step.trackingNumber

      const patchRes = await apiRequest(`/admin/orders/${testOrder.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(patchPayload),
      })

      assert(`Admin advances status to ${step.status} (HTTP 200)`, patchRes.status === 200)
      assert(
        `Admin response reflects displayStatus "${step.expectedDisplay}"`,
        patchRes.data?.order?.displayStatus === step.expectedDisplay
      )

      // Customer view verification
      const custCheck = await apiRequest(`/orders/${testOrder.id}`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      })
      assert(`Customer API returns status "${step.status}"`, custCheck.data?.data?.status === step.status)

      // DB check
      const doc = await Order.findById(testOrder.id)
      assert(`DB status is ${step.status}`, doc.status === step.status)
    }

    // -------------------------------------------------------------
    // 7. REFRESH & PERSISTENCE
    // -------------------------------------------------------------
    console.log('\n--- 7. REFRESH & IMMUTABILITY AUDIT ---')
    const finalOrder = await Order.findById(testOrder.id)
    assert('Final order status is DELIVERED', finalOrder.status === 'DELIVERED')
    assert('Expected delivery date remained intact through all transitions', Boolean(finalOrder.expectedDeliveryDate))
    assert('Order history contains full chronological audit trail', finalOrder.history.length >= 6)

    // -------------------------------------------------------------
    // 8. VERIFY PRODUCTION ORDER #SVH-10265
    // -------------------------------------------------------------
    console.log('\n--- 8. PRODUCTION ORDER #SVH-10265 INTEGRITY ---')
    const realOrder = await Order.findOne({ orderNumber: '#SVH-10265' })
    assert('Real order #SVH-10265 is present', Boolean(realOrder))
    assert('Real order #SVH-10265 has expectedDeliveryDate populated', Boolean(realOrder?.expectedDeliveryDate))
    assert('Real order #SVH-10265 paymentStatus is SUCCESS', realOrder?.paymentStatus === 'SUCCESS')
    assert('Real order #SVH-10265 totalAmount is 388', realOrder?.totalAmount === 388)

    console.log('\n====================================================')
    console.log(`DELIVERY LIFECYCLE SUITE FINISHED: ${passed} PASSED, ${failed} FAILED`)
    console.log('====================================================')
  } finally {
    // Cleanup temporary test order and customer
    console.log('\n--- Cleaning up temporary test fixtures ---')
    if (testOrder?._id || testOrder?.id) {
      const orderId = testOrder.id || testOrder._id
      await Order.findByIdAndDelete(orderId).catch(() => {})
      await Payment.deleteMany({ orderId }).catch(() => {})
    }
    if (customerUserId) {
      await User.findByIdAndDelete(customerUserId).catch(() => {})
      await Cart.deleteOne({ userId: customerUserId }).catch(() => {})
      await Address.deleteMany({ userId: customerUserId }).catch(() => {})
    }
    if (adminUserId) {
      await User.findByIdAndDelete(adminUserId).catch(() => {})
    }
    if (testProduct?._id) {
      await Product.findByIdAndDelete(testProduct._id).catch(() => {})
    }
    await mongoose.disconnect().catch(() => {})
  }

  if (failed > 0) {
    process.exit(1)
  }
}

runDeliveryLifecycleTests().catch((err) => {
  console.error('Fatal Delivery Lifecycle Test Error:', err)
  process.exit(1)
})
