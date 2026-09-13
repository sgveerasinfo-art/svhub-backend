#!/usr/bin/env node
/**
 * Production data cleanup for launch blockers:
 * 1) Align supportPhone to canonical +91 93463 99677
 * 2) Deactivate confirmed test coupon products (name/sku markers)
 * Does not print secrets. Uses DNS fallback for Atlas SRV.
 */
import 'dotenv/config'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import mongoose from 'mongoose'
import { env } from '../src/config/env.js'
import { Settings } from '../src/models/Settings.js'
import { Product } from '../src/models/Product.js'

dns.setServers(['8.8.8.8', '1.1.1.1', '9.9.9.9'])

const CANONICAL_PHONE = '+91 93463 99677'
const CANONICAL_EMAIL = 'sgveeras.info@gmail.com'

async function buildDirectUri(srvUri) {
  if (!srvUri.startsWith('mongodb+srv://')) return { uri: srvUri }
  const withoutScheme = srvUri.slice('mongodb+srv://'.length)
  const at = withoutScheme.indexOf('@')
  const creds = at >= 0 ? withoutScheme.slice(0, at) : ''
  const rest = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme
  const host = rest.split('/')[0].split('?')[0]
  let pq = rest.slice(host.length) || '/'
  if (!pq.startsWith('/')) pq = `/${pq}`
  const srv = await dnsPromises.resolveSrv(`_mongodb._tcp.${host}`)
  const hosts = srv.map((rec) => `${rec.name}:${rec.port}`)
  const hasQuery = pq.includes('?')
  const extras = []
  if (!/[?&]ssl=/.test(pq) && !/[?&]tls=/.test(pq)) extras.push('tls=true')
  if (!/[?&]retryWrites=/.test(pq)) extras.push('retryWrites=true')
  if (!/[?&]w=/.test(pq)) extras.push('w=majority')
  if (extras.length) pq += (hasQuery ? '&' : '?') + extras.join('&')
  return { uri: `mongodb://${creds}@${hosts.join(',')}${pq}` }
}

function isTestCouponProduct(doc) {
  const name = String(doc.name || '')
  const slug = String(doc.slug || '')
  const sku = String(doc.sku || '')
  if (/^Coupon Product\s+[AB]\b/i.test(name)) return true
  if (/cpn_\d+/i.test(name) || /cpn_\d+/i.test(slug) || /cpn_\d+/i.test(sku)) return true
  if (/coupon-product-[ab]/i.test(slug)) return true
  return false
}

async function main() {
  const rawUri = env.MONGODB_URI
  if (!rawUri) {
    console.error('MONGODB_URI missing')
    process.exit(1)
  }
  let connectUri = rawUri
  try {
    const built = await buildDirectUri(rawUri)
    connectUri = built.uri
  } catch (err) {
    console.warn('dns_fallback_failed_using_srv', err.message)
  }

  await mongoose.connect(connectUri, { dbName: env.MONGO_DB || 'svhub' })
  console.log('connected')

  const settings = await Settings.findOne({ key: 'store_settings' })
  if (!settings) {
    console.log('settings_missing_creating')
    await Settings.create({
      key: 'store_settings',
      supportPhone: CANONICAL_PHONE,
      supportEmail: CANONICAL_EMAIL,
    })
  } else {
    const before = settings.supportPhone
    settings.supportPhone = CANONICAL_PHONE
    if (!settings.supportEmail) settings.supportEmail = CANONICAL_EMAIL
    await settings.save()
    console.log('supportPhone_updated', { before, after: CANONICAL_PHONE })
  }

  const products = await Product.find({
    $or: [
      { name: /Coupon Product/i },
      { name: /cpn_/i },
      { slug: /cpn_/i },
      { sku: /cpn_/i },
      { slug: /coupon-product/i },
    ],
  }).lean()

  let deactivated = 0
  for (const p of products) {
    if (!isTestCouponProduct(p)) {
      console.log('skip_non_test', { id: String(p._id), name: p.name })
      continue
    }
    await Product.updateOne(
      { _id: p._id },
      { $set: { isActive: false, updatedAt: new Date() } },
    )
    deactivated += 1
    console.log('deactivated_test_product', { id: String(p._id), name: p.name, slug: p.slug })
  }
  console.log('test_products_deactivated', deactivated)
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('failed', err.message)
  process.exit(1)
})
