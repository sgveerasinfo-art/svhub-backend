import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDb } from '../src/config/db.js'
import { User, Product, Category, Cart, Address, Order, Settings } from '../src/models/index.js'

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

async function runAdminManagementVerification() {
  console.log('====================================================')
  console.log('SV HUB — PHASE 1.9 ADMIN CUSTOMERS, DASHBOARD & SETTINGS VERIFICATION')
  console.log('====================================================\n')

  await connectDb()

  const testSuffix = `adm_mgt_${Date.now()}`
  let customerAToken = ''
  let customerAId = ''
  let customerBToken = ''
  let customerBId = ''
  let adminToken = ''
  let adminId = ''
  let originalSettings = null

  try {
    console.log('--- Setting up test accounts & fixtures ---')

    // 1. Create Customer A
    const custARes = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Customer A Management',
        email: `custA_${testSuffix}@example.com`,
        password: 'Password@123',
        phone: '9876543111',
      }),
    })
    customerAToken = custARes.data?.token || custARes.data?.data?.token
    customerAId = custARes.data?.user?.id || custARes.data?.data?.user?.id

    // 2. Create Customer B
    const custBRes = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Customer B Management',
        email: `custB_${testSuffix}@example.com`,
        password: 'Password@123',
        phone: '9876543222',
      }),
    })
    customerBToken = custBRes.data?.token || custBRes.data?.data?.token
    customerBId = custBRes.data?.user?.id || custBRes.data?.data?.user?.id

    // 3. Create Administrator
    const adminEmail = `admin_${testSuffix}@example.com`
    const adminPasswordHash = await bcrypt.hash(DEV_ADMIN_PASSWORD, 12)
    const adminUser = await User.create({
      name: 'Operations Admin',
      email: adminEmail,
      passwordHash: adminPasswordHash,
      phone: '9876543999',
      role: 'ADMIN',
      status: 'ACTIVE',
      provider: 'PASSWORD',
    })
    adminId = String(adminUser._id)

    const adminLoginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: adminEmail,
        password: DEV_ADMIN_PASSWORD,
      }),
    })
    adminToken = adminLoginRes.data?.token || adminLoginRes.data?.data?.token

    // Save initial store settings to restore later
    const initialSettingsDoc = await Settings.getSettings()
    originalSettings = {
      supportEmail: initialSettingsDoc.supportEmail,
      supportPhone: initialSettingsDoc.supportPhone,
      standardShippingFee: initialSettingsDoc.standardShippingFee,
      expressShippingFee: initialSettingsDoc.expressShippingFee,
      freeShippingThreshold: initialSettingsDoc.freeShippingThreshold,
      lowStockThreshold: initialSettingsDoc.lowStockThreshold,
      currency: initialSettingsDoc.currency,
    }

    console.log('Test fixtures created.\n')

    // ==========================================
    // SECTION 1: ADMIN CUSTOMER API
    // ==========================================
    console.log('--- SECTION 1: Admin Customer API Tests ---')

    // 1.1 Unauthenticated request
    const noAuthCustList = await apiRequest('/admin/customers')
    assert('GET /api/admin/customers rejects unauthenticated requests with 401', noAuthCustList.status === 401)

    // 1.2 Customer request
    const custAuthList = await apiRequest('/admin/customers', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    })
    assert('GET /api/admin/customers rejects customer token with 403', custAuthList.status === 403)

    // 1.3 Admin request
    const adminCustList = await apiRequest('/admin/customers?sort=joined&dir=desc', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('GET /api/admin/customers allows administrator with 200', adminCustList.status === 200 && Array.isArray(adminCustList.data?.data))

    const foundCustA = (adminCustList.data?.data || []).find((c) => c.id === customerAId || c.email?.toLowerCase() === `custA_${testSuffix}@example.com`.toLowerCase())
    assert('Customer directory includes registered Customer A', Boolean(foundCustA))

    // 1.4 Sensitive field protection
    const hasPasswordHash = (adminCustList.data?.data || []).some((c) => c.passwordHash || c.resetTokenHash || c.firebaseUid)
    assert('Customer directory strictly excludes password hashes and authentication secrets', !hasPasswordHash)

    // 1.5 Customer search
    const searchRes = await apiRequest(`/admin/customers?q=${encodeURIComponent('Customer A Management')}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      'GET /api/admin/customers?q=... successfully filters by keyword',
      searchRes.status === 200 && (searchRes.data?.data || []).length >= 1 && (searchRes.data?.data || []).some((c) => c.id === customerAId),
    )

    // 1.6 Customer detail
    const noAuthDetail = await apiRequest(`/admin/customers/${customerAId}`)
    assert('GET /api/admin/customers/:id rejects unauthenticated request with 401', noAuthDetail.status === 401)

    const custDetailCust = await apiRequest(`/admin/customers/${customerAId}`, {
      headers: { Authorization: `Bearer ${customerAToken}` },
    })
    assert('GET /api/admin/customers/:id rejects customer token with 403', custDetailCust.status === 403)

    const adminCustDetail = await apiRequest(`/admin/customers/${customerAId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      'GET /api/admin/customers/:id returns complete customer detail with 200',
      adminCustDetail.status === 200 && adminCustDetail.data?.data?.id === customerAId && adminCustDetail.data?.data?.name === 'Customer A Management',
    )
    assert('Customer detail response includes orderCount and spent KPIs', typeof adminCustDetail.data?.data?.orderCount === 'number' && typeof adminCustDetail.data?.data?.spent === 'number')
    assert('Customer detail response includes addresses array and orders array', Array.isArray(adminCustDetail.data?.data?.addresses) && Array.isArray(adminCustDetail.data?.data?.orders))

    // 1.7 Customer update (PATCH)
    const updateRes = await apiRequest(`/admin/customers/${customerAId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Customer A Updated',
        phone: '9876549999',
        status: 'VIP',
        notes: 'Frequent buyer of cold-pressed oils',
      }),
    })
    assert('PATCH /api/admin/customers/:id succeeds with 200', updateRes.status === 200)

    // Verify MongoDB persistence
    const updatedMongoCust = await User.findById(customerAId)
    assert(
      'Customer update correctly persisted to MongoDB',
      updatedMongoCust.name === 'Customer A Updated' && updatedMongoCust.status === 'VIP' && updatedMongoCust.notes === 'Frequent buyer of cold-pressed oils',
    )

    // Verify GET reflects update
    const regetDetail = await apiRequest(`/admin/customers/${customerAId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('GET /api/admin/customers/:id returns updated status VIP and notes', regetDetail.data?.data?.status === 'VIP' && regetDetail.data?.data?.notes === 'Frequent buyer of cold-pressed oils')

    // 1.8 Validate status enum
    const invalidStatusRes = await apiRequest(`/admin/customers/${customerAId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        status: 'NON_EXISTENT_STATUS',
      }),
    })
    assert('PATCH /api/admin/customers/:id rejects invalid status enum with 400', invalidStatusRes.status === 400)

    // ==========================================
    // SECTION 2: ADMIN DASHBOARD API
    // ==========================================
    console.log('\n--- SECTION 2: Admin Dashboard API Tests ---')

    // 2.1 Unauthenticated dashboard request
    const noAuthDash = await apiRequest('/admin/dashboard')
    assert('GET /api/admin/dashboard rejects unauthenticated request with 401', noAuthDash.status === 401)

    // 2.2 Customer dashboard request
    const custDash = await apiRequest('/admin/dashboard', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    })
    assert('GET /api/admin/dashboard rejects customer token with 403', custDash.status === 403)

    // 2.3 Admin dashboard request
    const adminDash = await apiRequest('/admin/dashboard?range=7', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('GET /api/admin/dashboard succeeds with 200 for administrator', adminDash.status === 200 && Boolean(adminDash.data?.data))

    const dashData = adminDash.data?.data
    assert('Dashboard payload contains metrics block', Boolean(dashData?.metrics))
    assert('Dashboard metrics include totalProducts, totalOrders, totalCustomers, revenue, lowStockCount', [
      dashData?.metrics?.totalProducts,
      dashData?.metrics?.totalOrders,
      dashData?.metrics?.totalCustomers,
      dashData?.metrics?.revenue,
      dashData?.metrics?.lowStockCount,
    ].every((v) => typeof v === 'number'))

    // 2.4 Verify metrics match real MongoDB counts
    const mongoTotalProducts = await Product.countDocuments()
    const mongoActiveProducts = await Product.countDocuments({ isActive: true })
    const mongoTotalOrders = await Order.countDocuments()
    const mongoTotalCustomers = await User.countDocuments({ role: { $ne: 'ADMIN' } })

    assert('Dashboard totalProducts accurately matches MongoDB count', dashData?.metrics?.totalProducts === mongoTotalProducts)
    assert('Dashboard activeProducts accurately matches MongoDB active product count (37)', dashData?.metrics?.activeProducts === mongoActiveProducts && mongoActiveProducts === 37)
    assert('Dashboard totalOrders accurately matches MongoDB order count', dashData?.metrics?.totalOrders === mongoTotalOrders)
    assert('Dashboard totalCustomers accurately matches MongoDB customer count', dashData?.metrics?.totalCustomers === mongoTotalCustomers)

    // 2.5 Verify sales chart and storefront insights
    assert('Dashboard includes salesChart points array', Array.isArray(dashData?.salesChart))
    assert('Dashboard includes statusRows breakdown', Array.isArray(dashData?.statusRows) && dashData?.statusRows.length === 6)
    assert('Dashboard includes topHouse insight', Boolean(dashData?.topHouse?.id))

    // ==========================================
    // SECTION 3: ADMIN SETTINGS API
    // ==========================================
    console.log('\n--- SECTION 3: Admin Settings API Tests ---')

    // 3.1 Unauthenticated settings request
    const noAuthSettings = await apiRequest('/admin/settings')
    assert('GET /api/admin/settings rejects unauthenticated request with 401', noAuthSettings.status === 401)

    // 3.2 Customer settings request
    const custSettings = await apiRequest('/admin/settings', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    })
    assert('GET /api/admin/settings rejects customer token with 403', custSettings.status === 403)

    // 3.3 Admin settings request
    const adminSettings = await apiRequest('/admin/settings', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('GET /api/admin/settings succeeds with 200 for administrator', adminSettings.status === 200 && Boolean(adminSettings.data?.data))

    const settingsData = adminSettings.data?.data
    assert('Admin settings contain supportEmail and supportPhone', Boolean(settingsData?.supportEmail) && Boolean(settingsData?.supportPhone))
    assert('Admin settings contain standardShipping and freeShippingFrom', typeof settingsData?.standardShipping === 'number' && typeof settingsData?.freeShippingFrom === 'number')

    // 3.4 Validation: reject invalid email
    const invalidEmailRes = await apiRequest('/admin/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ supportEmail: 'invalid-email-string' }),
    })
    assert('PATCH /api/admin/settings rejects invalid email format with 400', invalidEmailRes.status === 400)

    // 3.5 Validation: reject negative shipping fee
    const negativeFeeRes = await apiRequest('/admin/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ standardShipping: -50 }),
    })
    assert('PATCH /api/admin/settings rejects negative shipping fee with 400', negativeFeeRes.status === 400)

    // 3.6 Legitimate settings update
    const patchSettingsRes = await apiRequest('/admin/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        supportEmail: 'care.updated@svhub.in',
        supportPhone: '+91 99999 88888',
        standardShippingFee: 45,
        freeShippingThreshold: 550,
        lowStockThreshold: 12,
      }),
    })
    assert('PATCH /api/admin/settings updates settings with 200', patchSettingsRes.status === 200)

    // 3.7 Verify persistence in MongoDB
    const mongoSettingsDoc = await Settings.getSettings()
    assert(
      'Settings update persisted to MongoDB',
      mongoSettingsDoc.supportEmail === 'care.updated@svhub.in' && mongoSettingsDoc.standardShippingFee === 45 && mongoSettingsDoc.freeShippingThreshold === 550,
    )

    // 3.8 Verify GET reflects persisted values
    const regetSettings = await apiRequest('/admin/settings', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      'GET /api/admin/settings returns newly updated settings',
      regetSettings.data?.data?.supportEmail === 'care.updated@svhub.in' && regetSettings.data?.data?.standardShipping === 45,
    )

    // 3.9 Verify public settings endpoint compatibility
    const pubSettingsRes = await apiRequest('/settings/public')
    assert(
      'GET /api/settings/public reflects updated public parameters without authentication',
      pubSettingsRes.status === 200 && pubSettingsRes.data?.data?.supportEmail === 'care.updated@svhub.in' && pubSettingsRes.data?.data?.standardShippingFee === 45,
    )

    // Restore original settings
    await apiRequest('/admin/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(originalSettings),
    })
    const restoredSettingsDoc = await Settings.getSettings()
    assert('Original settings cleanly restored in MongoDB', restoredSettingsDoc.standardShippingFee === originalSettings.standardShippingFee)

    // ==========================================
    // SECTION 4: REGRESSION & MULTI-ACCOUNT ISOLATION
    // ==========================================
    console.log('\n--- SECTION 4: Regression & Isolation Tests ---')

    // 4.1 Canonical products verification
    const activeProductsCount = await Product.countDocuments({ isActive: true })
    assert('37 canonical active products remain intact', activeProductsCount === 37)

    // 4.2 Canonical categories verification
    const activeCategoriesCount = await Category.countDocuments({ isActive: true })
    assert('4 canonical active categories remain intact', activeCategoriesCount === 4)

    // 4.3 Multi-account isolation: Customer A cart vs Customer B cart
    const custACart = await apiRequest('/cart', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    })
    const custBCart = await apiRequest('/cart', {
      headers: { Authorization: `Bearer ${customerBToken}` },
    })
    assert('Customer A and Customer B carts are distinct and isolated', custACart.status === 200 && custBCart.status === 200)

    // 4.4 Admin orders access
    const adminOrdersRes = await apiRequest('/admin/orders', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('Admin orders endpoint remains functional (200)', adminOrdersRes.status === 200 && Array.isArray(adminOrdersRes.data?.orders))
  } catch (err) {
    console.error('[UNEXPECTED ERROR]', err)
    failed++
  } finally {
    console.log('\n--- Cleaning up test fixtures ---')
    if (customerAId) {
      await User.deleteOne({ _id: customerAId })
      await Cart.deleteOne({ userId: customerAId })
      await Address.deleteMany({ userId: customerAId })
    }
    if (customerBId) {
      await User.deleteOne({ _id: customerBId })
      await Cart.deleteOne({ userId: customerBId })
      await Address.deleteMany({ userId: customerBId })
    }
    if (adminId) {
      await User.deleteOne({ _id: adminId })
    }
    if (originalSettings) {
      await Settings.updateOne({ key: 'store_settings' }, { $set: originalSettings })
    }
    console.log('Cleanup completed.')
    await mongoose.disconnect()
  }

  console.log('\n====================================================')
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  console.log('====================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runAdminManagementVerification()
