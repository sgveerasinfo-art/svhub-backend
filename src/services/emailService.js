/**
 * Outbound email delivery.
 *
 * No SMTP provider is wired yet. Configure one of:
 * - SMTP_URL (e.g. smtp://user:pass@host:587)
 * - RESEND_API_KEY + EMAIL_FROM
 *
 * Until configured, send* helpers return { sent: false } and never log secrets/tokens.
 */

import { env } from '../config/env.js'

export function isEmailDeliveryConfigured() {
  return Boolean(
    process.env.SMTP_URL ||
      process.env.RESEND_API_KEY ||
      process.env.EMAIL_PROVIDER === 'console',
  )
}

function fromAddress() {
  return process.env.EMAIL_FROM || process.env.SUPPORT_EMAIL || 'noreply@svhub.shop'
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} payload
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendEmail(payload) {
  const to = String(payload?.to || '').trim().toLowerCase()
  if (!to) return { sent: false, reason: 'missing_recipient' }

  if (!isEmailDeliveryConfigured()) {
    return { sent: false, reason: 'email_not_configured' }
  }

  // Development console sink — never print tokens (caller must pass redacted text if needed).
  if (process.env.EMAIL_PROVIDER === 'console' || env.NODE_ENV !== 'production') {
    if (process.env.EMAIL_PROVIDER === 'console') {
      console.info('[email] queued', {
        to,
        subject: payload.subject,
        from: fromAddress(),
      })
    }
    // Still not a real delivery unless EMAIL_PROVIDER=console intentionally.
    if (process.env.EMAIL_PROVIDER === 'console') {
      return { sent: true }
    }
  }

  // Provider adapters can be added here without changing call sites.
  return { sent: false, reason: 'email_provider_not_implemented' }
}

export async function sendPasswordResetEmail({ to, resetUrl }) {
  return sendEmail({
    to,
    subject: 'Reset your SV Hub password',
    text: `Use this link to reset your password (expires soon):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Use this link to reset your password (expires soon):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
  })
}

export async function sendAdminInvitationEmail({ to, setupUrl, name }) {
  return sendEmail({
    to,
    subject: 'You are invited to SV Hub Admin',
    text: `Hello ${name || ''},\n\nYou have been invited to the SV Hub Admin panel. Create your password here (link expires):\n\n${setupUrl}\n\nIf you were not expecting this, ignore this email.`,
    html: `<p>Hello ${name || ''},</p><p>You have been invited to the SV Hub Admin panel. Create your password using this link (expires soon):</p><p><a href="${setupUrl}">${setupUrl}</a></p><p>If you were not expecting this, ignore this email.</p>`,
  })
}
