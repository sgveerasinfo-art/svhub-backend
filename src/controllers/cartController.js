import mongoose from 'mongoose'
import { Cart } from '../models/Cart.js'
import { Product } from '../models/Product.js'
import {
  validateAndQuote,
  formatAppliedCoupon,
  listAvailableCouponsForCart,
  couponErrorMessage,
} from '../services/couponService.js'
import { normalizeCouponCode } from '../models/Coupon.js'

const PRODUCT_CART_PROJECTION =
  'name slug type category storefront image isActive variants.variantId variants.label variants.weight variants.sku variants.price variants.originalPrice variants.discount variants.qty variants.isActive'

async function attachCouponQuote(cart, resolved, userId) {
  const code = cart?.appliedCouponCode ? normalizeCouponCode(cart.appliedCouponCode) : ''
  if (!code) {
    return {
      ...resolved,
      appliedCouponCode: null,
      appliedCoupon: null,
      couponMessage: null,
    }
  }

  if (!resolved.items || resolved.items.length === 0) {
    if (cart.appliedCouponCode) {
      cart.appliedCouponCode = null
      await cart.save()
    }
    return {
      ...resolved,
      appliedCouponCode: null,
      appliedCoupon: null,
      couponMessage: 'Coupon removed because your cart is empty.',
    }
  }

  const result = await validateAndQuote({
    code,
    cartItems: cart.items,
    userId,
  })

  if (!result.ok) {
    cart.appliedCouponCode = null
    await cart.save()
    return {
      ...resolved,
      appliedCouponCode: null,
      appliedCoupon: null,
      couponMessage: result.error?.message || couponErrorMessage(result.error?.code),
      couponError: result.error,
    }
  }

  return {
    ...resolved,
    appliedCouponCode: result.quote.code,
    appliedCoupon: formatAppliedCoupon(result.quote),
    couponMessage: null,
  }
}

export async function populateCart(cart, { userId = null } = {}) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    return {
      id: cart ? String(cart._id) : null,
      items: [],
      count: 0,
      subtotal: 0,
      appliedCouponCode: null,
      appliedCoupon: null,
      couponMessage: null,
    }
  }

  const productIds = cart.items.map((i) => i.productId)
  const products = await Product.find({ _id: { $in: productIds } })
    .select(PRODUCT_CART_PROJECTION)
    .lean()
  const productMap = new Map(products.map((p) => [String(p._id), p]))

  const resolvedItems = []
  let totalCount = 0
  let totalSubtotal = 0

  for (const item of cart.items) {
    const product = productMap.get(String(item.productId))
    if (!product || product.isActive === false) {
      continue
    }

    const variant = (product.variants || []).find((v) => v.variantId === item.variantId)
    if (!variant || variant.isActive === false) {
      continue
    }

    const price = variant.price
    const originalPrice = variant.originalPrice || null
    const discount = variant.discount || null
    const lineTotal = price * item.quantity
    const inStock = variant.qty >= item.quantity && variant.qty > 0
    const stockStatus =
      variant.qty > 0 ? (variant.qty <= 10 ? 'low-stock' : 'in-stock') : 'out-of-stock'

    resolvedItems.push({
      id: String(item._id),
      itemId: String(item._id),
      productId: String(product._id),
      slug: product.slug,
      name: product.name,
      type: product.type,
      category: product.category,
      storefront: product.storefront,
      variantId: variant.variantId,
      variantLabel: variant.label,
      weight: variant.weight,
      sku: variant.sku,
      image: product.image,
      price,
      originalPrice,
      discount,
      quantity: item.quantity,
      lineTotal,
      stock: stockStatus,
      availableStock: variant.qty,
      inStock,
      maxAllowed: Math.min(99, variant.qty),
    })

    totalCount += item.quantity
    totalSubtotal += lineTotal
  }

  const base = {
    id: String(cart._id),
    items: resolvedItems,
    count: totalCount,
    subtotal: totalSubtotal,
  }

  return attachCouponQuote(cart, base, userId || cart.userId)
}

async function findOrCreateCart(userId) {
  let cart = await Cart.findOne({ userId })
  if (!cart) {
    try {
      cart = await Cart.create({ userId, items: [] })
    } catch (err) {
      if (err.code === 11000) {
        cart = await Cart.findOne({ userId })
      } else {
        throw err
      }
    }
  }
  return cart
}

function findCartLine(cart, targetId) {
  const id = String(targetId || '').trim()
  return (cart.items || []).find((i) => String(i._id) === id || i.variantId === id)
}

// 1. Get authenticated customer cart
export async function getCart(req, res, next) {
  try {
    const cart = await Cart.findOne({ userId: req.user._id })
    const resolved = await populateCart(cart, { userId: req.user._id })
    res.json({
      success: true,
      data: resolved,
    })
  } catch (err) {
    next(err)
  }
}

// 2. Add product variant line item to cart
export async function addToCart(req, res, next) {
  try {
    const { productId, variantId } = req.body || {}

    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_product_id',
          message: 'A valid productId is required.',
        },
      })
    }

    const cleanVariantId = String(variantId || '').trim()
    if (!cleanVariantId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_variant_id',
          message: 'A valid variantId is required.',
        },
      })
    }

    const rawQty = req.body.quantity
    const qty = rawQty !== undefined ? Number(rawQty) : 1
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_quantity',
          message: 'Quantity must be an integer between 1 and 99.',
        },
      })
    }

    const product = await Product.findOne({ _id: productId, isActive: true })
      .select(PRODUCT_CART_PROJECTION)
    if (!product) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'product_not_found',
          message: 'Product not found or is no longer active.',
        },
      })
    }

    const variant = (product.variants || []).find(
      (v) => v.variantId === cleanVariantId && v.isActive !== false,
    )
    if (!variant) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'variant_not_found',
          message: 'Selected variant is not available.',
        },
      })
    }

    let resolved
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cart = await findOrCreateCart(req.user._id)
      const existingItem = cart.items.find(
        (i) => String(i.productId) === String(product._id) && i.variantId === variant.variantId,
      )
      const targetQty = existingItem ? existingItem.quantity + qty : qty

      if (targetQty > 99) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'quantity_limit_exceeded',
            message: 'Maximum 99 units allowed per cart line.',
          },
        })
      }

      if (targetQty > variant.qty) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'insufficient_stock',
            message: `Only ${variant.qty} units available in stock.`,
          },
        })
      }

      if (existingItem) {
        // Atomic absolute set to computed target avoids lost increments under concurrency
        // when this request is the sole writer; retry handles VersionError races.
        existingItem.quantity = targetQty
      } else {
        cart.items.push({
          productId: product._id,
          variantId: variant.variantId,
          quantity: targetQty,
        })
      }

      try {
        await cart.save()
        resolved = await populateCart(cart)
        break
      } catch (error) {
        if (error?.name === 'VersionError' && attempt < 2) continue
        throw error
      }
    }

    res.json({
      success: true,
      data: resolved,
    })
  } catch (err) {
    next(err)
  }
}

// 3. Update quantity of existing cart item
export async function updateCartItem(req, res, next) {
  try {
    const rawQty = req.body?.quantity
    const qty = rawQty !== undefined ? Number(rawQty) : NaN
    if (!Number.isInteger(qty) || qty < 0 || qty > 99) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'invalid_quantity',
          message: 'Quantity must be an integer between 0 and 99.',
        },
      })
    }

    const targetId = String(req.params.id || '').trim()
    if (!targetId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'item_not_found',
          message: 'Item not found in cart.',
        },
      })
    }

    // Prefer atomic operators to avoid lost updates / VersionError under rapid clicks.
    if (qty === 0) {
      const pullFilter = mongoose.isValidObjectId(targetId)
        ? { userId: req.user._id, 'items._id': targetId }
        : { userId: req.user._id, 'items.variantId': targetId }

      const cart = await Cart.findOneAndUpdate(
        pullFilter,
        {
          $pull: mongoose.isValidObjectId(targetId)
            ? { items: { _id: targetId } }
            : { items: { variantId: targetId } },
        },
        { new: true },
      )

      if (!cart) {
        // Distinguish missing cart vs missing item
        const existing = await Cart.findOne({ userId: req.user._id }).lean()
        if (!existing) {
          return res.status(404).json({
            success: false,
            error: { code: 'cart_not_found', message: 'Cart not found.' },
          })
        }
        return res.status(404).json({
          success: false,
          error: { code: 'item_not_found', message: 'Item not found in cart.' },
        })
      }

      const resolved = await populateCart(cart)
      return res.json({ success: true, data: resolved })
    }

    // Stock check requires product read; then atomic $set on the line quantity.
    const cart = await Cart.findOne({ userId: req.user._id })
    if (!cart) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'cart_not_found',
          message: 'Cart not found.',
        },
      })
    }

    const item = findCartLine(cart, targetId)
    if (!item) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'item_not_found',
          message: 'Item not found in cart.',
        },
      })
    }

    const product = await Product.findOne({ _id: item.productId, isActive: true })
      .select(PRODUCT_CART_PROJECTION)
    if (!product) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'product_unavailable',
          message: 'Product is no longer available.',
        },
      })
    }

    const variant = (product.variants || []).find(
      (v) => v.variantId === item.variantId && v.isActive !== false,
    )
    if (!variant) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'variant_unavailable',
          message: 'Variant is no longer available.',
        },
      })
    }

    if (qty > variant.qty) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'insufficient_stock',
          message: `Only ${variant.qty} units available in stock.`,
        },
      })
    }

    const updated = await Cart.findOneAndUpdate(
      { userId: req.user._id, 'items._id': item._id },
      { $set: { 'items.$.quantity': qty } },
      { new: true },
    )

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'item_not_found',
          message: 'Item not found in cart.',
        },
      })
    }

    const resolved = await populateCart(updated)
    res.json({
      success: true,
      data: resolved,
    })
  } catch (err) {
    next(err)
  }
}

// 4. Remove cart line item
export async function removeCartItem(req, res, next) {
  try {
    const targetId = String(req.params.id || '').trim()
    if (!targetId) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'item_not_found',
          message: 'Item not found in cart.',
        },
      })
    }

    const filter = mongoose.isValidObjectId(targetId)
      ? { userId: req.user._id, 'items._id': targetId }
      : { userId: req.user._id, 'items.variantId': targetId }

    const cart = await Cart.findOneAndUpdate(
      filter,
      {
        $pull: mongoose.isValidObjectId(targetId)
          ? { items: { _id: targetId } }
          : { items: { variantId: targetId } },
      },
      { new: true },
    )

    if (!cart) {
      const existing = await Cart.findOne({ userId: req.user._id }).lean()
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: { code: 'cart_not_found', message: 'Cart not found.' },
        })
      }
      return res.status(404).json({
        success: false,
        error: { code: 'item_not_found', message: 'Item not found in cart.' },
      })
    }

    const resolved = await populateCart(cart)
    res.json({
      success: true,
      data: resolved,
    })
  } catch (err) {
    next(err)
  }
}

// 5. Clear all cart items
export async function clearCart(req, res, next) {
  try {
    const cart = await Cart.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { items: [], appliedCouponCode: null } },
      { new: true },
    )

    res.json({
      success: true,
      data: {
        id: cart ? String(cart._id) : null,
        items: [],
        count: 0,
        subtotal: 0,
        appliedCouponCode: null,
        appliedCoupon: null,
        couponMessage: null,
      },
    })
  } catch (err) {
    next(err)
  }
}

// 6. Merge guest items into server cart on login
export async function mergeCart(req, res, next) {
  try {
    const incomingItems = Array.isArray(req.body?.items) ? req.body.items : []

    const productIds = [
      ...new Set(
        incomingItems
          .map((item) => item?.productId)
          .filter((id) => id && mongoose.isValidObjectId(id))
          .map(String),
      ),
    ]

    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds }, isActive: true })
          .select(PRODUCT_CART_PROJECTION)
          .lean()
      : []
    const productMap = new Map(products.map((p) => [String(p._id), p]))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cart = await findOrCreateCart(req.user._id)

      for (const item of incomingItems) {
        const { productId, variantId, quantity } = item || {}
        if (!productId || !mongoose.isValidObjectId(productId) || !variantId) continue

        const qty = Math.max(1, Math.min(99, parseInt(quantity || 1, 10) || 1))
        const product = productMap.get(String(productId))
        if (!product) continue

        const variant = (product.variants || []).find(
          (v) => v.variantId === variantId && v.isActive !== false,
        )
        if (!variant) continue

        const existing = cart.items.find(
          (i) => String(i.productId) === String(product._id) && i.variantId === variant.variantId,
        )

        if (existing) {
          existing.quantity = Math.min(99, Math.min(variant.qty, existing.quantity + qty))
        } else {
          const allowedQty = Math.min(99, Math.min(variant.qty, qty))
          if (allowedQty > 0) {
            cart.items.push({
              productId: product._id,
              variantId: variant.variantId,
              quantity: allowedQty,
            })
          }
        }
      }

      try {
        await cart.save()
        const resolved = await populateCart(cart)
        return res.json({
          success: true,
          data: resolved,
        })
      } catch (error) {
        if (error?.name === 'VersionError' && attempt < 2) continue
        throw error
      }
    }
  } catch (err) {
    next(err)
  }
}

// 7. Apply coupon code to cart
export async function applyCartCoupon(req, res, next) {
  try {
    const code = normalizeCouponCode(req.body?.code)
    if (!code) {
      return res.status(400).json({
        success: false,
        error: { code: 'coupon_missing_code', message: 'Enter a coupon code.' },
      })
    }

    const cart = await findOrCreateCart(req.user._id)
    if (!cart.items || cart.items.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'coupon_empty_cart',
          message: 'Add items to your cart before applying a coupon.',
        },
      })
    }

    const previousCode = cart.appliedCouponCode ? normalizeCouponCode(cart.appliedCouponCode) : null
    const result = await validateAndQuote({
      code,
      cartItems: cart.items,
      userId: req.user._id,
    })

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        error: result.error,
      })
    }

    cart.appliedCouponCode = result.quote.code
    await cart.save()

    const resolved = await populateCart(cart, { userId: req.user._id })
    const replaced = Boolean(previousCode && previousCode !== result.quote.code)

    res.json({
      success: true,
      data: resolved,
      meta: {
        replaced,
        message: replaced
          ? 'Replaced previous coupon'
          : result.quote.message,
      },
    })
  } catch (err) {
    next(err)
  }
}

// 8. Remove applied coupon from cart
export async function removeCartCoupon(req, res, next) {
  try {
    const cart = await Cart.findOne({ userId: req.user._id })
    if (cart) {
      cart.appliedCouponCode = null
      await cart.save()
    }
    const resolved = await populateCart(cart, { userId: req.user._id })
    res.json({
      success: true,
      data: resolved,
    })
  } catch (err) {
    next(err)
  }
}

// 9. List coupons that currently apply to this cart
export async function getAvailableCartCoupons(req, res, next) {
  try {
    const cart = await Cart.findOne({ userId: req.user._id })
    const items = cart?.items || []
    const coupons = await listAvailableCouponsForCart({
      cartItems: items,
      userId: req.user._id,
    })
    res.json({ success: true, data: coupons })
  } catch (err) {
    next(err)
  }
}
