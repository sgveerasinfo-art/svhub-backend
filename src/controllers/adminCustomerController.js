import mongoose from 'mongoose'
import { User } from '../models/User.js'
import { Order } from '../models/Order.js'
import { Address } from '../models/Address.js'
import { customerRoleFilter } from '../utils/adminRoles.js'

function escapeRegex(text) {
  return String(text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

const ALLOWED_STATUSES = ['ACTIVE', 'VIP', 'INACTIVE', 'SUSPENDED']

/**
 * GET /api/admin/customers
 * Returns enriched customer list with pagination, search, status & tier filtering, and sorting
 */
export async function getAdminCustomers(req, res, next) {
  try {
    const {
      q,
      search,
      status,
      tier,
      sort = 'spent',
      dir = 'desc',
      page = 1,
      limit = 20,
    } = req.query

    const searchQuery = String(q || search || '').trim()
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    // Base match criteria: exclude staff (Admin / Super Admin)
    const matchCriteria = {
      ...customerRoleFilter(),
    }

    // Status filter
    if (status && status.toLowerCase() !== 'all') {
      const upperStatus = status.toUpperCase()
      if (ALLOWED_STATUSES.includes(upperStatus)) {
        matchCriteria.status = upperStatus
      }
    }

    // Keyword search across name, email, phone
    if (searchQuery) {
      const escaped = escapeRegex(searchQuery)
      const regex = new RegExp(escaped, 'i')
      matchCriteria.$or = [
        { name: regex },
        { email: regex },
        { phone: regex },
      ]
    }

    // Build aggregation pipeline to compute customer KPIs and retrieve primary location
    const pipeline = [
      { $match: matchCriteria },
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'userId',
          as: 'orderDocs',
        },
      },
      {
        $lookup: {
          from: 'addresses',
          localField: '_id',
          foreignField: 'userId',
          as: 'addressDocs',
        },
      },
      {
        $addFields: {
          orderCount: { $size: '$orderDocs' },
          spent: {
            $reduce: {
              input: '$orderDocs',
              initialValue: 0,
              in: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$$this.status', 'CANCELLED'] },
                      { $ne: ['$$this.paymentStatus', 'FAILED'] },
                    ],
                  },
                  { $add: ['$$value', { $ifNull: ['$$this.totalAmount', 0] }] },
                  '$$value',
                ],
              },
            },
          },
          lastOrderDoc: {
            $arrayElemAt: [
              {
                $sortArray: {
                  input: '$orderDocs',
                  sortBy: { createdAt: -1 },
                },
              },
              0,
            ],
          },
          defaultAddressDoc: {
            $arrayElemAt: [
              {
                $filter: {
                  input: '$addressDocs',
                  as: 'addr',
                  cond: { $eq: ['$$addr.isDefault', true] },
                },
              },
              0,
            ],
          },
          firstAddressDoc: {
            $arrayElemAt: ['$addressDocs', 0],
          },
        },
      },
      {
        $addFields: {
          primaryAddress: {
            $ifNull: ['$defaultAddressDoc', '$firstAddressDoc'],
          },
          lastOrder: '$lastOrderDoc.createdAt',
          lastOrderId: '$lastOrderDoc.orderNumber',
        },
      },
      {
        $addFields: {
          city: { $ifNull: ['$primaryAddress.city', ''] },
          state: { $ifNull: ['$primaryAddress.state', ''] },
        },
      },
    ]

    // Tier filtering based on computed metrics
    if (tier && tier !== 'all') {
      if (tier === 'high') {
        pipeline.push({ $match: { spent: { $gte: 2000 } } })
      } else if (tier === 'repeat') {
        pipeline.push({ $match: { orderCount: { $gte: 2 } } })
      } else if (tier === 'single') {
        pipeline.push({ $match: { orderCount: 1 } })
      } else if (tier === 'none') {
        pipeline.push({ $match: { orderCount: 0 } })
      }
    }

    // Determine sort stage
    const sortOrder = String(dir).toLowerCase() === 'asc' ? 1 : -1
    let sortStage = { spent: sortOrder }
    if (sort === 'name') {
      sortStage = { name: sortOrder }
    } else if (sort === 'joined' || sort === 'createdAt') {
      sortStage = { createdAt: sortOrder }
    } else if (sort === 'orders' || sort === 'orderCount') {
      sortStage = { orderCount: sortOrder }
    } else if (sort === 'spent') {
      sortStage = { spent: sortOrder }
    }

    pipeline.push({ $sort: sortStage })

    // Facet for total count and paginated items
    pipeline.push({
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [{ $skip: skip }, { $limit: limitNum }],
      },
    })

    const [results] = await User.aggregate(pipeline)
    const total = results?.metadata?.[0]?.total || 0
    const rawData = results?.data || []

    const formattedCustomers = rawData.map((doc) => ({
      id: String(doc._id),
      _id: String(doc._id),
      name: doc.name,
      email: doc.email,
      phone: doc.phone || '',
      role: (doc.role || 'CUSTOMER').toUpperCase(),
      status: (doc.status || 'ACTIVE').toUpperCase(),
      city: doc.city || '',
      state: doc.state || '',
      joined: doc.createdAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      orderCount: doc.orderCount || 0,
      spent: doc.spent || 0,
      lastOrder: doc.lastOrder || null,
      lastOrderId: doc.lastOrderId || null,
      notes: doc.notes || '',
    }))

    res.json({
      success: true,
      data: formattedCustomers,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/admin/customers/:id
 * Returns complete customer detail with order history, addresses, and spending metrics
 */
export async function getAdminCustomerById(req, res, next) {
  try {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({
        success: false,
        code: 'customer_not_found',
        message: 'Invalid customer identifier',
      })
    }

    const user = await User.findById(id).select('-passwordHash -resetTokenHash')
    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'customer_not_found',
        message: 'Customer not found',
      })
    }

    // Retrieve addresses and orders in parallel
    const [addresses, orders] = await Promise.all([
      Address.find({ userId: user._id }).sort({ isDefault: -1, createdAt: -1 }),
      Order.find({ userId: user._id }).sort({ createdAt: -1 }),
    ])

    const orderCount = orders.length
    const spent = orders
      .filter((o) => o.status !== 'CANCELLED' && o.paymentStatus !== 'FAILED')
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0)
    const averageOrderValue = orderCount ? Math.round(spent / orderCount) : 0

    const formattedOrders = orders.map((order) => {
      const items = (order.items || []).map((item) => ({
        id: item.variantId || String(item.productId),
        name: item.productName,
        quantity: item.quantity,
        price: item.unitPrice,
        sku: item.sku,
      }))
      return {
        id: String(order._id),
        _id: String(order._id),
        number: order.orderNumber,
        date: order.createdAt,
        createdAt: order.createdAt,
        amount: order.totalAmount,
        totalAmount: order.totalAmount,
        status: order.status,
        paymentStatus: order.paymentStatus,
        items,
      }
    })

    const defaultAddr = addresses.find((a) => a.isDefault) || addresses[0]

    const customerDetail = {
      id: String(user._id),
      _id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: (user.role || 'CUSTOMER').toUpperCase(),
      status: (user.status || 'ACTIVE').toUpperCase(),
      city: defaultAddr?.city || '',
      state: defaultAddr?.state || '',
      joined: user.createdAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      notes: user.notes || '',
      orderCount,
      spent,
      averageOrderValue,
      addresses: addresses.map((a) => ({
        id: String(a._id),
        label: a.label,
        name: a.name,
        phone: a.phone,
        street: a.street,
        city: a.city,
        state: a.state,
        pin: a.pin,
        country: a.country,
        isDefault: a.isDefault,
      })),
      orders: formattedOrders,
    }

    res.json({
      success: true,
      data: customerDetail,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * PATCH /api/admin/customers/:id
 * Updates legitimate customer administrative fields (name, phone, status, notes)
 */
export async function updateAdminCustomer(req, res, next) {
  try {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({
        success: false,
        code: 'customer_not_found',
        message: 'Invalid customer identifier',
      })
    }

    const user = await User.findById(id)
    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'customer_not_found',
        message: 'Customer not found',
      })
    }

    const { name, phone, status, notes } = req.body || {}

    // Update name
    if (name !== undefined) {
      const trimmedName = String(name).trim()
      if (trimmedName.length < 2) {
        return res.status(400).json({
          success: false,
          code: 'invalid_name',
          message: 'Customer name must be at least 2 characters',
        })
      }
      user.name = trimmedName
    }

    // Update phone
    if (phone !== undefined) {
      user.phone = String(phone).trim()
    }

    // Update status
    if (status !== undefined) {
      const upperStatus = String(status).trim().toUpperCase()
      if (!ALLOWED_STATUSES.includes(upperStatus)) {
        return res.status(400).json({
          success: false,
          code: 'invalid_status',
          message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
        })
      }
      user.status = upperStatus
    }

    // Update notes
    if (notes !== undefined) {
      user.notes = String(notes).trim()
    }

    await user.save()

    res.json({
      success: true,
      data: {
        id: String(user._id),
        _id: String(user._id),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        role: user.role,
        status: user.status,
        notes: user.notes || '',
        updatedAt: user.updatedAt,
      },
    })
  } catch (err) {
    next(err)
  }
}
