import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDb } from '../src/config/db.js'
import { User, Product, Category, Cart, Address, Order, Counter } from '../src/models/index.js'

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

async function runAdminOrderVerification() {
  console.log('====================================================')
  console.log('SV HUB — PHASE 1.6A ADMIN ORDER MANAGEMENT VERIFICATION')
  console.log('====================================================\n')

  await connectDb()

  const testSuffix = `adm_test_${Date.now()}`
  let customerToken = ''
  let customerId = ''
  let adminToken = ''
  let adminId = ''
  let testProduct = null
  let testOrder = null
  let secondOrder = null

  try {
    console.log('--- Setting up test users & fixtures ---')

    // 1. Create Normal Customer
    const custRes = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Normal Customer',
        email: `cust_${testSuffix}@example.com`,
        password: 'Password@123',
        phone: '9876540001',
      }),
    })
    customerToken = custRes.data?.token
    customerId = custRes.data?.user?.id

    // 2. Create Admin User
    const adminUser = await User.create({
      name: 'Admin Supervisor',
      email: `admin_${testSuffix}@example.com`,
      passwordHash: await bcrypt.hash(DEV_ADMIN_PASSWORD, 10),
      phone: '9876540002',
      role: 'ADMIN',
      status: 'ACTIVE',
      provider: 'PASSWORD',
    })
    adminId = String(adminUser._id)

    // Login as Admin to get Admin JWT
    const adminLoginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: `admin_${testSuffix}@example.com`,
        password: DEV_ADMIN_PASSWORD,
      }),
    })
    adminToken = adminLoginRes.data?.token

    // 3. Create test Product
    testProduct = await Product.create({
      name: `Admin Test Product ${testSuffix}`,
      slug: `adm-prod-${testSuffix}`,
      type: 'Traditional Food',
      category: 'staples',
      storefront: 'nutri-hub',
      description: 'Product for admin order tests',
      image: 'https://images.unsplash.com/photo-adm-test',
      price: 250,
      weight: '500g',
      sku: `SKU-ADM-BASE-${testSuffix}`,
      qty: 50,
      isActive: true,
      variants: [
        {
          variantId: 'var-1',
          label: '500g',
          weight: '500g',
          sku: `SKU-ADM-${testSuffix}`,
          price: 250,
          originalPrice: 300,
          discount: 16,
          qty: 50,
          isActive: true,
        },
      ],
    })

    // 4. Create initial test Order 1
    const seq1 = await Counter.getNextSequence('order_number')
    const orderNum1 = `#SVH-ADM-${seq1}`
    testOrder = await Order.create({
      orderNumber: orderNum1,
      userId: customerId,
      customerName: 'Normal Customer',
      email: `cust_${testSuffix}@example.com`,
      phone: '9876540001',
      shippingAddress: {
        name: 'Normal Customer',
        phone: '9876540001',
        street: '123 Test Street',
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pin: '641001',
        country: 'India',
        lines: ['123 Test Street', 'Coimbatore, Tamil Nadu - 641001'],
      },
      items: [
        {
          productId: testProduct._id,
          variantId: 'var-1',
          productName: testProduct.name,
          variantLabel: '500g',
          weight: '500g',
          sku: `SKU-ADM-${testSuffix}`,
          unitPrice: 250,
          originalPrice: 300,
          discount: 16,
          quantity: 2,
          lineTotal: 500,
          image: '',
          storefront: 'nutri-hub',
        },
      ],
      subtotal: 500,
      shippingFee: 50,
      discount: 0,
      totalAmount: 550,
      status: 'CONFIRMED',
      paymentStatus: 'SUCCESS',
      courier: null,
      trackingNumber: null,
      notes: 'Initial order notes',
      history: [
        {
          status: 'PENDING_PAYMENT',
          at: new Date(Date.now() - 3600000),
          note: 'Order created',
        },
        {
          status: 'CONFIRMED',
          at: new Date(Date.now() - 1800000),
          note: 'Payment verified and confirmed',
        },
      ],
    })

    // 5. Create initial test Order 2 for listing/filtering tests
    const seq2 = await Counter.getNextSequence('order_number')
    const orderNum2 = `#SVH-ADM-${seq2}`
    secondOrder = await Order.create({
      orderNumber: orderNum2,
      userId: customerId,
      customerName: 'Special Customer Bob',
      email: `bob_${testSuffix}@example.com`,
      phone: '9876540009',
      shippingAddress: {
        name: 'Special Customer Bob',
        phone: '9876540009',
        street: '456 Sample Ave',
        city: 'Chennai',
        state: 'Tamil Nadu',
        pin: '600001',
        country: 'India',
        lines: ['456 Sample Ave', 'Chennai, Tamil Nadu - 600001'],
      },
      items: [
        {
          productId: testProduct._id,
          variantId: 'var-1',
          productName: testProduct.name,
          variantLabel: '500g',
          weight: '500g',
          sku: `SKU-ADM-${testSuffix}`,
          unitPrice: 250,
          originalPrice: 300,
          discount: 16,
          quantity: 1,
          lineTotal: 250,
          image: '',
          storefront: 'self-care',
        },
      ],
      subtotal: 250,
      shippingFee: 50,
      discount: 0,
      totalAmount: 300,
      status: 'DELIVERED',
      paymentStatus: 'FAILED',
      notes: '',
      history: [
        {
          status: 'DELIVERED',
          at: new Date(),
          note: 'Delivered',
        },
      ],
    })

    console.log('\n--- Running 30 Verification Tests ---\n')

    // ==========================================
    // AUTHENTICATION TESTS (1 - 2)
    // ==========================================
    // 1. No token → rejected (401)
    const t1 = await apiRequest('/admin/orders')
    assert('1. No token → rejected (401 unauthorized)', t1.status === 401)

    // 2. Invalid token → rejected (401)
    const t2 = await apiRequest('/admin/orders', {
      headers: { Authorization: 'Bearer invalid.token.value' },
    })
    assert('2. Invalid token → rejected (401 invalid_token)', t2.status === 401)

    // ==========================================
    // AUTHORIZATION TESTS (3 - 4)
    // ==========================================
    // 3. Normal customer JWT → rejected with 403
    const t3 = await apiRequest('/admin/orders', {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert(
      '3. Normal customer JWT → rejected with 403 (forbidden_admin_access)',
      t3.status === 403 && (t3.data?.code === 'forbidden_admin_access' || t3.data?.error?.code === 'forbidden_admin_access'),
    )

    // 4. Admin JWT → allowed (200)
    const t4 = await apiRequest('/admin/orders', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('4. Admin JWT → allowed (200)', t4.status === 200 && t4.data?.success === true)

    // ==========================================
    // LISTING TESTS (5 - 9)
    // ==========================================
    // 5. Admin can list orders
    assert(
      '5. Admin can list orders with array response',
      t4.data?.orders && Array.isArray(t4.data.orders) && t4.data.orders.length >= 2,
    )

    // 6. Pagination works
    const t6 = await apiRequest('/admin/orders?page=1&limit=1', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '6. Pagination works (limit, page, total, totalPages)',
      t6.status === 200 &&
        t6.data?.orders?.length === 1 &&
        t6.data?.pagination?.limit === 1 &&
        t6.data?.pagination?.page === 1 &&
        t6.data?.pagination?.total >= 2 &&
        t6.data?.pagination?.totalPages >= 2,
    )

    // 7. Search works
    const t7 = await apiRequest(`/admin/orders?search=${encodeURIComponent(orderNum1)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const foundByNumber = t7.data?.orders?.some((o) => o.orderNumber === orderNum1 || o.number === orderNum1)
    assert('7. Search works by orderNumber', t7.status === 200 && foundByNumber)

    // 8. Status filter works
    const t8 = await apiRequest('/admin/orders?status=DELIVERED', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const onlyDelivered =
      t8.data?.orders?.length > 0 &&
      t8.data.orders.every((o) => o.status === 'DELIVERED' || o.displayStatus === 'Delivered')
    assert('8. Status filter works', t8.status === 200 && onlyDelivered)

    // 9. Payment filter works
    const t9 = await apiRequest('/admin/orders?paymentStatus=FAILED', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const onlyFailed =
      t9.data?.orders?.length > 0 &&
      t9.data.orders.every((o) => o.paymentStatus === 'FAILED' || o.rawPaymentStatus === 'FAILED')
    assert('9. Payment status filter works', t9.status === 200 && onlyFailed)

    // ==========================================
    // DETAIL TESTS (10 - 12)
    // ==========================================
    // 10. Admin can retrieve order
    const t10 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '10. Admin can retrieve single order details',
      t10.status === 200 &&
        t10.data?.success === true &&
        (t10.data?.order?.orderNumber === orderNum1 || t10.data?.order?.number === orderNum1) &&
        t10.data?.order?.subtotal === 500,
    )

    // 11. Invalid ObjectId handled
    const t11 = await apiRequest('/admin/orders/not-a-valid-object-id-123', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '11. Invalid ObjectId handled properly (400 or 404)',
      t11.status === 400 || t11.status === 404,
    )

    // 12. Nonexistent order handled
    const fakeId = new mongoose.Types.ObjectId()
    const t12 = await apiRequest(`/admin/orders/${fakeId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '12. Nonexistent order handled (404 order_not_found)',
      t12.status === 404 && (t12.data?.code === 'order_not_found' || t12.data?.error?.code === 'order_not_found'),
    )

    // ==========================================
    // UPDATE TESTS (13 - 20)
    // ==========================================
    // 13. Admin can update status
    const initialHistoryLength = testOrder.history.length
    const t13 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'PROCESSING' }),
    })
    assert(
      '13. Admin can update status to PROCESSING',
      t13.status === 200 &&
        (t13.data?.order?.status === 'PROCESSING' || t13.data?.order?.displayStatus === 'Processing'),
    )

    // 14. Admin can update tracking
    const t14 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ trackingNumber: 'TRACK-123456' }),
    })
    assert(
      '14. Admin can update trackingNumber',
      t14.status === 200 && t14.data?.order?.trackingNumber === 'TRACK-123456',
    )

    // 15. Admin can update courier
    const t15 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ courier: 'BlueDart Express' }),
    })
    assert(
      '15. Admin can update courier',
      t15.status === 200 && t15.data?.order?.courier === 'BlueDart Express',
    )

    // 16. Admin can update notes
    const t16 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ notes: 'Dispatched from central warehouse.' }),
    })
    assert(
      '16. Admin can update notes',
      t16.status === 200 && t16.data?.order?.notes === 'Dispatched from central warehouse.',
    )

    // 17. Invalid status rejected
    const t17 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'BOGUS_STATUS' }),
    })
    assert(
      '17. Invalid status rejected (400 invalid_order_status)',
      t17.status === 400 && (t17.data?.code === 'invalid_order_status' || t17.data?.error?.code === 'invalid_order_status'),
    )

    // 18. Unknown/immutable fields rejected or ignored
    const t18 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subtotal: 9999,
        totalAmount: 1,
        items: [{ productName: 'Hacked Product', unitPrice: 1 }],
      }),
    })
    const orderDoc18 = await Order.findById(testOrder._id)
    assert(
      '18. Unknown/immutable fields cannot be mutated (subtotal & items preserved)',
      orderDoc18.subtotal === 500 &&
        orderDoc18.totalAmount === 550 &&
        orderDoc18.items[0].productName === testProduct.name,
    )

    // 19. Status history created on transition
    assert(
      '19. Status history created on status change',
      orderDoc18.history.length === initialHistoryLength + 1 &&
        orderDoc18.history[orderDoc18.history.length - 1].status === 'PROCESSING',
    )

    // 20. Same-status update does not duplicate history
    const historyLenBeforeSame = orderDoc18.history.length
    await apiRequest(`/admin/orders/${testOrder._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'PROCESSING', notes: 'Updated notes again' }),
    })
    const orderDoc20 = await Order.findById(testOrder._id)
    assert(
      '20. Same-status update does not duplicate history entries',
      orderDoc20.history.length === historyLenBeforeSame,
    )

    // ==========================================
    // CANCELLATION TESTS (21 - 25)
    // ==========================================
    // Check product stock before cancel
    const prodBefore = await Product.findById(testProduct._id)
    const stockBefore = prodBefore.variants[0].qty

    // 21. Admin can cancel valid order
    const t21 = await apiRequest(`/admin/orders/${testOrder._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ reason: 'Customer changed delivery address and cancelled.' }),
    })
    assert(
      '21. Admin can cancel valid order (status CANCELLED)',
      t21.status === 200 &&
        (t21.data?.order?.status === 'CANCELLED' || t21.data?.order?.displayStatus === 'Cancelled'),
    )

    // 22. Cancellation reason required
    const t22 = await apiRequest(`/admin/orders/${secondOrder._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ reason: '' }),
    })
    assert(
      '22. Empty cancellation reason rejected (400 cancellation_reason_required)',
      t22.status === 400 &&
        (t22.data?.code === 'cancellation_reason_required' || t22.data?.error?.code === 'cancellation_reason_required'),
    )

    // 23. Already cancelled order rejected
    const t23 = await apiRequest(`/admin/orders/${testOrder._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ reason: 'Trying to cancel again' }),
    })
    assert(
      '23. Already cancelled order rejected (400 order_already_cancelled)',
      t23.status === 400 &&
        (t23.data?.code === 'order_already_cancelled' || t23.data?.error?.code === 'order_already_cancelled'),
    )

    // 24. Cancellation history created with note
    const orderDoc24 = await Order.findById(testOrder._id)
    const lastHistory = orderDoc24.history[orderDoc24.history.length - 1]
    assert(
      '24. Cancellation history created with status CANCELLED and reason note',
      lastHistory.status === 'CANCELLED' &&
        lastHistory.note === 'Customer changed delivery address and cancelled.',
    )

    // 25. Inventory is NOT incorrectly increased
    const prodAfter = await Product.findById(testProduct._id)
    const stockAfter = prodAfter.variants[0].qty
    assert(
      '25. Inventory is NOT increased upon order cancellation',
      stockBefore === stockAfter && stockAfter === 50,
    )

    // ==========================================
    // IMMUTABILITY TESTS (26 - 28)
    // ==========================================
    // 26. Product snapshot unchanged
    assert(
      '26. Historical product snapshot unchanged (name, price, SKU, lineTotal preserved)',
      orderDoc24.items[0].productName === testProduct.name &&
        orderDoc24.items[0].unitPrice === 250 &&
        orderDoc24.items[0].sku === `SKU-ADM-${testSuffix}` &&
        orderDoc24.items[0].lineTotal === 500,
    )

    // 27. Address snapshot unchanged
    assert(
      '27. Historical shipping address snapshot unchanged',
      orderDoc24.shippingAddress.street === '123 Test Street' &&
        orderDoc24.shippingAddress.city === 'Coimbatore' &&
        orderDoc24.shippingAddress.pin === '641001',
    )

    // 28. Order financial totals unchanged by operational updates
    assert(
      '28. Order financial totals unchanged by operational updates',
      orderDoc24.subtotal === 500 &&
        orderDoc24.shippingFee === 50 &&
        orderDoc24.totalAmount === 550,
    )

    // ==========================================
    // SECURITY TESTS (29 - 30)
    // ==========================================
    // 29. Admin cannot access sensitive customer auth fields
    const orderDoc29Res = await apiRequest(`/admin/orders/${testOrder._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const userField = orderDoc29Res.data?.order?.user || orderDoc29Res.data?.order?.userId
    assert(
      '29. User credentials and password hashes stripped from admin order response',
      userField &&
        userField.passwordHash === undefined &&
        userField.password === undefined &&
        userField.resetPasswordToken === undefined &&
        userField.firebaseUid === undefined,
    )

    // 30. Customer cannot access admin endpoint
    const t30 = await apiRequest(`/admin/orders/${testOrder._id}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert(
      '30. Customer cannot access admin order detail endpoint (403 forbidden_admin_access)',
      t30.status === 403 && (t30.data?.code === 'forbidden_admin_access' || t30.data?.error?.code === 'forbidden_admin_access'),
    )
  } catch (err) {
    console.error('Test execution exception:', err)
    failed++
  } finally {
    // Cleanup test artifacts
    console.log('\n--- Cleaning up test fixtures ---')
    if (customerId) await User.findByIdAndDelete(customerId)
    if (adminId) await User.findByIdAndDelete(adminId)
    if (testProduct) await Product.findByIdAndDelete(testProduct._id)
    if (testOrder) await Order.findByIdAndDelete(testOrder._id)
    if (secondOrder) await Order.findByIdAndDelete(secondOrder._id)
    await mongoose.disconnect()
  }

  console.log('\n====================================================')
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  console.log('====================================================')

  if (failed > 0) {
    process.exit(1)
  }
}

runAdminOrderVerification()
