/**
 * Outbound email delivery.
 *
 * Configure ONE of:
 * - RESEND_API_KEY (+ optional EMAIL_FROM)
 * - SMTP_URL (smtp://user:pass@host:587) — requires `nodemailer` package
 * - EMAIL_PROVIDER=console (dev only; marks sent without real delivery)
 *
 * Never logs raw reset/invitation tokens or passwords.
 */

import { env } from '../config/env.js'

export function isEmailDeliveryConfigured() {
  if (process.env.EMAIL_PROVIDER === 'console') return true
  if (process.env.RESEND_API_KEY) return true
  if (process.env.SMTP_URL) return true
  return false
}

function fromAddress() {
  return process.env.EMAIL_FROM || process.env.SUPPORT_EMAIL || 'noreply@svhub.shop'
}

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      text,
      html: html || undefined,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('[email] resend_failed', {
      status: response.status,
      // Never log full provider body if it might echo recipient content with tokens
      hint: body ? 'provider_error' : 'empty_body',
    })
    return { sent: false, reason: 'resend_failed' }
  }

  return { sent: true }
}

async function sendViaSmtp({ to, subject, text, html }) {
  let nodemailer
  try {
    nodemailer = await import('nodemailer')
  } catch {
    console.error('[email] smtp_unavailable', { reason: 'nodemailer_not_installed' })
    return { sent: false, reason: 'smtp_dependency_missing' }
  }

  const transporter = nodemailer.createTransport(process.env.SMTP_URL)
  try {
    await transporter.sendMail({
      from: fromAddress(),
      to,
      subject,
      text,
      html,
    })
    return { sent: true }
  } catch (error) {
    console.error('[email] smtp_failed', { code: error?.code || 'smtp_error' })
    return { sent: false, reason: 'smtp_failed' }
  }
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

  if (process.env.EMAIL_PROVIDER === 'console') {
    console.info('[email] queued', {
      to,
      subject: payload.subject,
      from: fromAddress(),
    })
    return { sent: true }
  }

  if (process.env.RESEND_API_KEY) {
    return sendViaResend(payload)
  }

  if (process.env.SMTP_URL) {
    return sendViaSmtp(payload)
  }

  return { sent: false, reason: 'email_not_configured' }
}

export async function sendPasswordResetEmail({ to, resetUrl }) {
  // resetUrl contains the secret token — never log it.
  return sendEmail({
    to,
    subject: 'Reset your SV Hub password',
    text: `Use this link to reset your password (expires soon):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Use this link to reset your password (expires soon):</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, ignore this email.</p>`,
  })
}

export async function sendAdminInvitationEmail({ to, setupUrl, name }) {
  return sendEmail({
    to,
    subject: 'You are invited to SV Hub Admin',
    text: `Hello ${name || ''},\n\nYou have been invited to the SV Hub Admin panel. Create your password here (link expires):\n\n${setupUrl}\n\nIf you were not expecting this, ignore this email.`,
    html: `<p>Hello ${name || ''},</p><p>You have been invited to the SV Hub Admin panel. Create your password using this link (expires soon):</p><p><a href="${setupUrl}">Accept invitation</a></p><p>If you were not expecting this, ignore this email.</p>`,
  })
}

// Keep env import used for future NODE_ENV checks without unused lint noise in some setups
void env
