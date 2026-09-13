#!/usr/bin/env node
/**
 * Migrate existing staff accounts into Super Admin + invalidate compromised passwords.
 *
 * Usage (from svhub-backend, with MONGODB_URI set):
 *   node scripts/migrate-admin-access.js
 *
 * Effects:
 * - Promotes the first matching ADMIN (or ADMIN_EMAIL env) to SUPER_ADMIN
 * - Invalidates the current password hash (old exposed credentials stop working)
 * - Issues a one-time setup invitation URL printed ONCE to stdout (not logged to files)
 *
 * Does NOT print or store any plaintext password.
 */

import 'dotenv/config'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { User } from '../src/models/User.js'
import { AdminInvitation } from '../src/models/AdminInvitation.js'
import { env } from '../src/config/env.js'
import { createSecureToken, hashSecureToken, invitationTokenExpiry } from '../src/utils/secureTokens.js'

const SALT_ROUNDS = 12

function clientOrigin() {
  return String(env.CLIENT_URL || env.CLIENT_ORIGIN || 'https://www.svhub.shop').replace(/\/$/, '')
}

async function main() {
  const uri = env.MONGODB_URI
  if (!uri) {
    console.error('MONGODB_URI is required')
    process.exit(1)
  }

  await mongoose.connect(uri, { dbName: env.MONGO_DB || 'svhub' })

  const preferredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()

  let admin =
    (preferredEmail ? await User.findOne({ email: preferredEmail }) : null) ||
    (await User.findOne({ role: { $in: ['ADMIN', 'SUPER_ADMIN'] } }).sort({ createdAt: 1 }))

  if (!admin) {
    console.error('No existing admin user found. Create one manually or set ADMIN_EMAIL.')
    process.exit(1)
  }

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
  console.log(`Promoted user: ${admin.email}`)
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
