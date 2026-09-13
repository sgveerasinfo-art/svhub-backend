#!/usr/bin/env node
/**
 * Production-safe admin migration runner with DNS fallback.
 * Does not print secrets/tokens to files — setup URL only on stdout once.
 */
import 'dotenv/config'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { User } from '../src/models/User.js'
import { AdminInvitation } from '../src/models/AdminInvitation.js'
import { env } from '../src/config/env.js'
import { createSecureToken, hashSecureToken, invitationTokenExpiry } from '../src/utils/secureTokens.js'

dns.setServers(['8.8.8.8', '1.1.1.1', '9.9.9.9'])

const SALT_ROUNDS = 12

function clientOrigin() {
  return String(env.CLIENT_URL || env.CLIENT_ORIGIN || 'https://www.svhub.shop').replace(/\/$/, '')
}

function redactHost(uri) {
  try {
    const m = String(uri).match(/@([^/?]+)/)
    const host = m?.[1] || ''
    return host ? `${host.slice(0, 8)}…` : '(unknown-host)'
  } catch {
    return '(unknown-host)'
  }
}

async function buildDirectUri(srvUri) {
  if (!srvUri.startsWith('mongodb+srv://')) return { uri: srvUri, mode: 'as-is' }

  const withoutScheme = srvUri.slice('mongodb+srv://'.length)
  const at = withoutScheme.indexOf('@')
  const creds = at >= 0 ? withoutScheme.slice(0, at) : ''
  const rest = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme
  const host = rest.split('/')[0].split('?')[0]
  const pathAndQuery = rest.slice(host.length) // includes /db?...

  const srv = await dnsPromises.resolveSrv(`_mongodb._tcp.${host}`)
  if (!srv?.length) throw new Error('SRV lookup returned no hosts')

  const hosts = []
  for (const rec of srv) {
    // Keep hostnames (required for Atlas TLS/SNI). Do not substitute raw IPs.
    hosts.push(`${rec.name}:${rec.port}`)
  }

  // Strip srv-only params incompatible with standard URI if present
  let pq = pathAndQuery || '/'
  if (!pq.startsWith('/')) pq = `/${pq}`
  // Avoid duplicating common options already present in the source URI
  const hasQuery = pq.includes('?')
  const extras = []
  if (!/[?&]ssl=/.test(pq) && !/[?&]tls=/.test(pq)) extras.push('tls=true')
  if (!/[?&]retryWrites=/.test(pq)) extras.push('retryWrites=true')
  if (!/[?&]w=/.test(pq)) extras.push('w=majority')
  if (extras.length) {
    pq += (hasQuery ? '&' : '?') + extras.join('&')
  }
  const uri = `mongodb://${creds}@${hosts.join(',')}${pq}`
  return { uri, mode: 'direct-from-srv', hosts }
}

async function main() {
  const rawUri = env.MONGODB_URI
  if (!rawUri) {
    console.error('MONGODB_URI missing')
    process.exit(1)
  }

  console.log('migration_target_host', redactHost(rawUri))
  console.log('mongo_db', env.MONGO_DB || 'svhub')

  let connectUri = rawUri
  let mode = 'srv'
  try {
    await dnsPromises.resolveSrv(`_mongodb._tcp.${redactHost(rawUri).replace('…', '')}`)
  } catch {
    /* will try fallback */
  }

  try {
    const built = await buildDirectUri(rawUri)
    connectUri = built.uri
    mode = built.mode
    if (built.hosts) console.log('resolved_hosts', built.hosts.join(','))
  } catch (error) {
    console.log('direct_uri_build_failed', error.message)
    mode = 'srv-fallback'
    connectUri = rawUri
  }

  console.log('connect_mode', mode)

  await mongoose.connect(connectUri, {
    dbName: env.MONGO_DB || 'svhub',
    serverSelectionTimeoutMS: 20000,
  })
  console.log('mongo_connected', true)

  // Sanity: production should already have products / the known admin
  const productCount = await mongoose.connection.db.collection('products').countDocuments()
  const userCount = await mongoose.connection.db.collection('users').countDocuments()
  console.log('collections_probe', { products: productCount, users: userCount })
  if (productCount < 10) {
    console.error('Refusing migration: product count too low — possible wrong database')
    process.exit(2)
  }

  const preferredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  let admin =
    (preferredEmail ? await User.findOne({ email: preferredEmail }) : null) ||
    (await User.findOne({ role: { $in: ['ADMIN', 'SUPER_ADMIN'] } }).sort({ createdAt: 1 }))

  if (!admin) {
    console.error('No existing admin user found')
    process.exit(1)
  }

  console.log('migrating_admin_email_domain', String(admin.email).split('@')[1] || '')
  console.log('migrating_admin_role_before', admin.role)

  const existingSuper = await User.countDocuments({ role: 'SUPER_ADMIN' })
  console.log('existing_super_admins', existingSuper)

  const randomSecret = crypto.randomBytes(48).toString('hex')
  admin.role = 'SUPER_ADMIN'
  admin.status = 'INACTIVE'
  admin.passwordHash = await bcrypt.hash(randomSecret, SALT_ROUNDS)
  admin.authVersion = Number(admin.authVersion || 0) + 1
  admin.resetTokenHash = ''
  admin.resetTokenExpires = null
  await admin.save()

  await AdminInvitation.updateMany(
    { userId: admin._id, usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )

  const token = createSecureToken()
  const invite = await AdminInvitation.create({
    email: admin.email,
    name: admin.name || 'Super Admin',
    role: 'SUPER_ADMIN',
    userId: admin._id,
    tokenHash: hashSecureToken(token),
    expiresAt: invitationTokenExpiry(),
    invitedBy: admin._id,
  })

  const setupUrl = `${clientOrigin()}/admin/setup?token=${encodeURIComponent(token)}`
  console.log('Migration complete.')
  console.log(`Invitation id: ${invite._id}`)
  console.log('Old passwords for this account are invalidated.')
  console.log('One-time Super Admin setup URL (copy now; it will not be shown again):')
  console.log(setupUrl)

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error('Migration failed:', error.message)
  try {
    await mongoose.disconnect()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
