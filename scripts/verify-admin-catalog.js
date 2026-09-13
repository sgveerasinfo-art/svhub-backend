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

async function runAdminCatalogVerification() {
  console.log('====================================================')
  console.log('SV HUB — PHASE 1.8 ADMIN CATALOG & INVENTORY VERIFICATION')
  console.log('====================================================\n')

  await connectDb()

  const testSuffix = `adm_cat_${Date.now()}`
  let customerToken = ''
  let customerId = ''
  let adminToken = ''
  let adminId = ''
  let createdProductId = ''
  let createdProductSlug = ''
  let createdCategoryId = ''
  let createdCategorySlug = ''
  let testOrder = null

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

    const adminLoginRes = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: `admin_${testSuffix}@example.com`,
        password: DEV_ADMIN_PASSWORD,
      }),
    })
    adminToken = adminLoginRes.data?.token

    console.log('\n--- 1. Testing Admin Authorization & Access Controls ---')

    // 1. Unauthenticated GET /api/admin/products
    const unauthProd = await apiRequest('/admin/products')
    assert('1. Unauthenticated request to /admin/products returns 401', unauthProd.status === 401)

    // 2. Customer token to /api/admin/products
    const custProd = await apiRequest('/admin/products', {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert('2. Customer token to /admin/products returns 403', custProd.status === 403)

    // 3. Unauthenticated GET /api/admin/categories
    const unauthCat = await apiRequest('/admin/categories')
    assert('3. Unauthenticated request to /admin/categories returns 401', unauthCat.status === 401)

    // 4. Customer token to /api/admin/categories
    const custCat = await apiRequest('/admin/categories', {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    assert('4. Customer token to /admin/categories returns 403', custCat.status === 403)

    // 5. Admin token to /api/admin/products
    const adminProd = await apiRequest('/admin/products', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('5. Admin token to /admin/products returns 200', adminProd.status === 200 && adminProd.data?.success)

    // 6. Admin token to /api/admin/categories
    const adminCat = await apiRequest('/admin/categories', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('6. Admin token to /admin/categories returns 200', adminCat.status === 200 && adminCat.data?.success)

    console.log('\n--- 2. Testing Admin Product CRUD & Validation ---')

    // 7. Rejection of invalid product creation
    const emptyNameRes = await apiRequest('/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: '', price: 100 }),
    })
    assert('7. Missing product name rejected with 400', emptyNameRes.status === 400)

    const invalidCatRes = await apiRequest('/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Product',
        slug: `test-prod-${testSuffix}`,
        category: 'non-existent-category',
        price: 150,
      }),
    })
    assert('8. Non-existent category reference rejected with 400', invalidCatRes.status === 400)

    const invalidPriceRes = await apiRequest('/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Product',
        slug: `test-prod-${testSuffix}`,
        category: 'pickles-thokku',
        price: -50,
      }),
    })
    assert('9. Negative or zero price rejected with 400', invalidPriceRes.status === 400)

    createdProductSlug = `test-mango-jam-${testSuffix.replace(/_/g, '-')}`
    const createProdRes = await apiRequest('/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Mango Jam',
        slug: createdProductSlug,
        category: 'pickles-thokku',
        storefront: 'nutri-hub',
        price: 220,
        originalPrice: 260,
        discount: 15,
        sku: `SVH-NH-${testSuffix.slice(-6).toUpperCase()}`,
        qty: 35,
        weight: '350g',
        image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        description: 'Authentic handmade test mango jam.',
      }),
    })
    assert('10. Valid product creation succeeds with 201', createProdRes.status === 201 && createProdRes.data?.success)
    createdProductId = createProdRes.data?.data?.id
    createdProductSlug = createProdRes.data?.data?.slug || createdProductSlug

    // 11. Duplicate slug rejection
    const dupSlugRes = await apiRequest('/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Duplicate',
        slug: createdProductSlug,
        category: 'pickles-thokku',
        storefront: 'nutri-hub',
        price: 100,
        sku: `SVH-NH-DUP-${testSuffix.slice(-4)}`,
      }),
    })
    assert('11. Duplicate slug rejected with 400', dupSlugRes.status === 400)

    // 12. Retrieve product by ID & slug
    const getByIdRes = await apiRequest(`/admin/products/${createdProductId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '12. Admin can retrieve product by ObjectId',
      getByIdRes.status === 200 && getByIdRes.data?.data?.name === 'Test Mango Jam',
    )

    const getBySlugRes = await apiRequest(`/admin/products/${createdProductSlug}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert('13. Admin can retrieve product by slug', getBySlugRes.status === 200)

    // 14. Update product
    const updateProdRes = await apiRequest(`/admin/products/${createdProductId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Mango Jam Premium',
        price: 240,
        description: 'Updated premium description.',
      }),
    })
    assert(
      '14. Admin can update product details via PUT',
      updateProdRes.status === 200 && updateProdRes.data?.data?.name === 'Test Mango Jam Premium',
    )

    // 15. Verify update persisted in DB
    const dbProduct = await Product.findById(createdProductId).lean()
    assert(
      '15. Product updates persist in MongoDB',
      dbProduct?.name === 'Test Mango Jam Premium' && dbProduct?.price === 240,
    )

    console.log('\n--- 3. Testing Inventory Management ---')

    // 16. Update inventory via PATCH
    const invRes = await apiRequest(`/admin/products/${createdProductId}/inventory`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ stock: 75 }),
    })
    assert(
      '16. Admin can update inventory via PATCH /inventory',
      invRes.status === 200 && invRes.data?.data?.qty === 75,
    )

    // 17. Rejection of invalid negative stock
    const negInvRes = await apiRequest(`/admin/products/${createdProductId}/inventory`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ stock: -10 }),
    })
    assert('17. Negative stock rejected with 400', negInvRes.status === 400)

    // 18. Safe product deactivation via DELETE
    const delProdRes = await apiRequest(`/admin/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '18. Product deletion safely deactivates (isActive: false)',
      delProdRes.status === 200 && delProdRes.data?.data?.active === false,
    )

    // 19. Public catalog does NOT show deactivated product
    const publicProdRes = await apiRequest(`/products/${createdProductSlug}`)
    assert(
      '19. Deactivated product is hidden from public customer catalog (404)',
      publicProdRes.status === 404,
    )

    console.log('\n--- 4. Testing Admin Categories CRUD & Safety Checks ---')

    // 20. Category listing includes active product count
    const catListRes = await apiRequest('/admin/categories', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const picklesCat = (catListRes.data?.data || []).find((c) => c.slug === 'pickles-thokku')
    assert(
      '20. Categories list returns counts (pickles-thokku has >= 17 products)',
      catListRes.status === 200 && typeof picklesCat?.count === 'number' && picklesCat.count >= 17,
    )

    createdCategorySlug = `test-cat-${testSuffix.replace(/_/g, '-')}`
    const createCatRes = await apiRequest('/admin/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Category',
        slug: createdCategorySlug,
        storefront: 'nutri-hub',
        description: 'Test category description.',
        sortOrder: 10,
      }),
    })
    assert('21. Valid category creation succeeds with 201', createCatRes.status === 201 && createCatRes.data?.success)
    createdCategoryId = createCatRes.data?.data?.id
    createdCategorySlug = createCatRes.data?.data?.slug || createdCategorySlug

    // 22. Duplicate category slug rejection
    const dupCatRes = await apiRequest('/admin/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Duplicate Category',
        slug: createdCategorySlug,
        storefront: 'nutri-hub',
      }),
    })
    assert('22. Duplicate category slug rejected with 400', dupCatRes.status === 400)

    // 23. Update category
    const updateCatRes = await apiRequest(`/admin/categories/${createdCategoryId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'Test Category Updated',
        description: 'Updated category description.',
      }),
    })
    assert(
      '23. Admin can update category via PUT',
      updateCatRes.status === 200 && updateCatRes.data?.data?.name === 'Test Category Updated',
    )

    // 24. Category deletion safety check: Reject deletion when active products exist
    const deleteUsedCatRes = await apiRequest('/admin/categories/pickles-thokku', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '24. Category deletion rejected with 400 when active products belong to category',
      deleteUsedCatRes.status === 400 &&
        deleteUsedCatRes.data?.error?.code === 'cannot_delete_category_with_products',
    )

    // 25. Safe deletion when category has 0 active products
    const deleteEmptyCatRes = await apiRequest(`/admin/categories/${createdCategoryId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert(
      '25. Safe deletion/deactivation succeeds for category with 0 active products',
      deleteEmptyCatRes.status === 200 && deleteEmptyCatRes.data?.data?.active === false,
    )

    console.log('\n--- 5. Testing Historical Order Snapshot Immutability ---')

    // 26. Setup customer address and cart to place an order
    const addrRes = await apiRequest('/addresses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        name: 'Alice Tester',
        phone: '9876540001',
        street: '12 Temple Street',
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pin: '641001',
      }),
    })
    const addressId = addrRes.data?.data?.id

    // Use a canonical product for order snapshot verification
    const testProd = await Product.findOne({ isActive: true })
    const variant = testProd.variants[0]

    await apiRequest('/cart/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        productId: String(testProd._id),
        variantId: variant.variantId,
        quantity: 2,
      }),
    })

    const orderRes = await apiRequest('/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        addressId,
        paymentMethod: 'ONLINE',
      }),
    })
    testOrder = orderRes.data?.data
    assert('26. Order created successfully for snapshot immutability test', Boolean(testOrder?.orderNumber))

    // Admin mutates the product name, price, and description
    const originalItemSnapshot = testOrder.items[0]
    await apiRequest(`/admin/products/${testProd._id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: `${testProd.name} - TEMPORARILY MUTATED`,
        price: 999,
        description: 'Mutated description to verify snapshot immutability',
      }),
    })

    // Fetch the customer order and verify historical snapshot is unchanged
    const orderCheckRes = await apiRequest(`/orders/${testOrder.id}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    })
    const checkedItemSnapshot = orderCheckRes.data?.data?.items?.[0]

    assert(
      '27. Historical order item productName remains immutable despite admin product rename',
      checkedItemSnapshot?.productName === originalItemSnapshot.productName,
      `Expected "${originalItemSnapshot.productName}", got "${checkedItemSnapshot?.productName}"`,
    )
    assert(
      '28. Historical order item unitPrice remains immutable despite admin product price change',
      checkedItemSnapshot?.unitPrice === originalItemSnapshot.unitPrice,
      `Expected ${originalItemSnapshot.unitPrice}, got ${checkedItemSnapshot?.unitPrice}`,
    )

    // Revert the mutated product back to canonical values
    await apiRequest(`/admin/products/${testProd._id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: testProd.name,
        price: originalItemSnapshot.unitPrice,
        description: testProd.description,
      }),
    })

    console.log('\n--- 6. Canonical Catalog Safety Audit ---')

    // 29. Canonical 37 active products
    const activeProductsCount = await Product.countDocuments({ isActive: true })
    assert(
      '29. Exactly 37 canonical products are active in MongoDB',
      activeProductsCount === 37,
      `Expected 37, got ${activeProductsCount}`,
    )

    // 30. Canonical 4 active categories
    const activeCategoriesCount = await Category.countDocuments({ active: true })
    assert(
      '30. Exactly 4 canonical categories are active in MongoDB',
      activeCategoriesCount === 4,
      `Expected 4, got ${activeCategoriesCount}`,
    )

    // 31. Legacy products remain inactive
    const inactiveProductsCount = await Product.countDocuments({ isActive: false })
    assert(
      '31. Legacy products remain deactivated (>= 21 inactive)',
      inactiveProductsCount >= 21,
    )

    // 32. Zero duplicate active slugs
    const activeProducts = await Product.find({ isActive: true }).select('slug').lean()
    const slugSet = new Set(activeProducts.map((p) => p.slug))
    assert('32. Zero duplicate active slugs', slugSet.size === activeProducts.length)
  } catch (err) {
    console.error('[ERROR] Verification failed with exception:', err)
    failed++
  } finally {
    console.log('\n--- Cleaning up temporary test fixtures ---')
    if (createdProductId) {
      await Product.findByIdAndDelete(createdProductId)
    }
    if (createdCategoryId) {
      await Category.findByIdAndDelete(createdCategoryId)
    }
    if (customerId) {
      await User.findByIdAndDelete(customerId)
      await Cart.deleteOne({ user: customerId })
      await Address.deleteMany({ user: customerId })
      await Order.deleteMany({ user: customerId })
    }
    if (adminId) {
      await User.findByIdAndDelete(adminId)
    }
    await mongoose.disconnect()
  }

  console.log('\n====================================================')
  console.log(`ADMIN CATALOG VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  console.log('====================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runAdminCatalogVerification()
