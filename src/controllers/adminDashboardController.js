import { User } from '../models/User.js'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { Settings } from '../models/Settings.js'
import { customerRoleFilter } from '../utils/adminRoles.js'

const STATUS_DISPLAY_MAP = {
  PENDING_PAYMENT: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REQUIRES_RECONCILIATION: 'Pending',
}

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']

function getDayKey(date) {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function getLastNDays(n = 7) {
  const days = []
  const now = new Date()
  now.setHours(12, 0, 0, 0)
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    days.push(d)
  }
  return days
}

/**
 * GET /api/admin/dashboard
 * Aggregates real-time business KPIs, recent orders, sales trajectory, inventory alerts, and category insights
 */
export async function getAdminDashboard(req, res, next) {
  try {
    const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 7
    const settings = await Settings.getSettings()
    const lowStockThreshold = settings?.lowStockThreshold ?? 10

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - range)
    startDate.setHours(0, 0, 0, 0)

    // Execute aggregated queries concurrently
    const [
      totalCustomers,
      activeCustomers,
      totalProducts,
      activeProducts,
      totalOrders,
      orderStatusCountsAgg,
      totalRevenueResult,
      recentOrderDocs,
      lowStockAgg,
      rangeOrdersAgg,
      storefrontRevenueAgg,
      topItemAgg,
    ] = await Promise.all([
      User.countDocuments(customerRoleFilter()),
      User.countDocuments({ ...customerRoleFilter(), status: { $in: ['ACTIVE', 'VIP'] } }),
      Product.countDocuments(),
      Product.countDocuments({ isActive: true }),
      Order.countDocuments(),
      Order.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $ne: 'CANCELLED' },
            paymentStatus: { $in: ['SUCCESS', 'PAID'] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$totalAmount' },
          },
        },
      ]),
      Order.find()
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),
      Product.aggregate([
        { $match: { isActive: true } },
        {
          $project: {
            name: 1,
            slug: 1,
            storefront: 1,
            sku: { $arrayElemAt: ['$variants.sku', 0] },
            image: { $arrayElemAt: ['$variants.images', 0] },
            qty: { $sum: '$variants.stock' },
          },
        },
        { $sort: { qty: 1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            status: { $ne: 'CANCELLED' },
            paymentStatus: { $in: ['SUCCESS', 'PAID'] },
          },
        },
        {
          $project: {
            createdAt: 1,
            totalAmount: 1,
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $ne: 'CANCELLED' },
            paymentStatus: { $in: ['SUCCESS', 'PAID'] },
          },
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.storefront',
            revenue: { $sum: '$items.lineTotal' },
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $ne: 'CANCELLED' },
          },
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.productName',
            totalUnits: { $sum: '$items.quantity' },
          },
        },
        { $sort: { totalUnits: -1 } },
        { $limit: 1 },
      ]),
    ])

    const totalRevenue = totalRevenueResult?.[0]?.totalRevenue || 0

    // Map order status counts
    const countByRawStatus = new Map()
    orderStatusCountsAgg.forEach((item) => {
      countByRawStatus.set(item._id, item.count)
    })

    const countByUiStatus = new Map()
    ORDER_STATUSES.forEach((s) => countByUiStatus.set(s, 0))

    orderStatusCountsAgg.forEach((item) => {
      const uiStatus = STATUS_DISPLAY_MAP[item._id] || 'Pending'
      countByUiStatus.set(uiStatus, (countByUiStatus.get(uiStatus) || 0) + item.count)
    })

    const statusRows = ORDER_STATUSES.map((status) => ({
      status,
      count: countByUiStatus.get(status) || 0,
    }))

    const pendingOrdersCount = countByUiStatus.get('Pending') || 0
    const processingOrdersCount = countByUiStatus.get('Processing') || 0
    const shippedOrdersCount = countByUiStatus.get('Shipped') || 0
    const deliveredOrdersCount = countByUiStatus.get('Delivered') || 0
    const cancelledOrdersCount = countByUiStatus.get('Cancelled') || 0

    // Format recent orders
    const recentOrders = recentOrderDocs.map((o) => {
      const storefronts = [
        ...new Set((o.items || []).map((i) => i.storefront).filter(Boolean)),
      ]
      return {
        id: String(o._id),
        number: o.orderNumber,
        date: o.createdAt,
        customerName: o.customerName,
        storefronts,
        amount: o.totalAmount,
        status: STATUS_DISPLAY_MAP[o.status] || o.status,
      }
    })

    // Low stock products
    const lowStockProducts = lowStockAgg
      .filter((p) => p.qty <= lowStockThreshold)
      .map((p) => ({
        id: String(p._id),
        name: p.name,
        sku: p.sku || 'SVH-ITEM',
        storefront: p.storefront || 'nutri-hub',
        image: p.image || '',
        qty: p.qty,
        stock: p.qty === 0 ? 'out-of-stock' : 'low-stock',
      }))

    const lowestProduct = lowStockAgg[0]
      ? {
          id: String(lowStockAgg[0]._id),
          name: lowStockAgg[0].name,
          qty: lowStockAgg[0].qty,
        }
      : null

    // Sales by day calculation
    const days = getLastNDays(range)
    const revenueByDayMap = new Map()
    rangeOrdersAgg.forEach((o) => {
      const key = getDayKey(o.createdAt)
      revenueByDayMap.set(key, (revenueByDayMap.get(key) || 0) + (o.totalAmount || 0))
    })

    const salesByDay = days.map((date) => {
      const key = getDayKey(date)
      return {
        label:
          range === 7
            ? date.toLocaleDateString('en-GB', { weekday: 'short' })
            : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        total: revenueByDayMap.get(key) || 0,
        date: key,
      }
    })

    // Sample down if range is 30 or 90
    const sampledSales =
      range === 7
        ? salesByDay
        : salesByDay.filter(
            (_, index) =>
              index % Math.ceil(salesByDay.length / 8) === 0 || index === salesByDay.length - 1,
          )

    // Storefront breakdown
    let nutriRevenue = 0
    let careRevenue = 0
    storefrontRevenueAgg.forEach((s) => {
      if (s._id === 'nutri-hub') nutriRevenue = s.revenue
      if (s._id === 'self-care') careRevenue = s.revenue
    })

    const topHouse =
      nutriRevenue >= careRevenue
        ? { id: 'nutri-hub', value: nutriRevenue }
        : { id: 'self-care', value: careRevenue }

    const topItem = topItemAgg?.[0] ? [topItemAgg[0]._id, topItemAgg[0].totalUnits] : null

    res.json({
      success: true,
      data: {
        metrics: {
          totalCustomers,
          activeCustomers,
          totalProducts,
          activeProducts,
          totalOrders,
          pendingOrders: pendingOrdersCount,
          processingOrders: processingOrdersCount,
          shippedOrders: shippedOrdersCount,
          deliveredOrders: deliveredOrdersCount,
          cancelledOrders: cancelledOrdersCount,
          revenue: totalRevenue,
          lowStockCount: lowStockProducts.length,
        },
        statusRows,
        recentOrders,
        lowStockProducts,
        lowestProduct,
        salesChart: sampledSales,
        salesByDay,
        nutriRevenue,
        careRevenue,
        topHouse,
        topItem,
        range,
      },
    })
  } catch (err) {
    next(err)
  }
}
