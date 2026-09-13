import crypto from 'node:crypto'

const DEFAULT_TTL_MS = 30 * 60 * 1000
const INVITE_TTL_MS = 48 * 60 * 60 * 1000

export function createSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function hashSecureToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function resetTokenExpiry(from = Date.now()) {
  return new Date(from + DEFAULT_TTL_MS)
}

export function invitationTokenExpiry(from = Date.now()) {
  return new Date(from + INVITE_TTL_MS)
}

export { DEFAULT_TTL_MS, INVITE_TTL_MS }
