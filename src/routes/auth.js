import bcrypt from 'bcryptjs'
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'
import { isFirebaseAdminConfigured, verifyGoogleIdToken } from '../config/firebase.js'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  authLoginRateLimiter,
  authRegisterRateLimiter,
  authGoogleRateLimiter,
  authPasswordResetRateLimiter,
} from '../middleware/rateLimiter.js'
import { recordAuditLog } from '../services/auditLogger.js'
import { env } from '../config/env.js'
import {
  emailError,
  fail,
  jwtSecret,
  loginIdentifierError,
  nameError,
  normalizeEmail,
  normalizePhone,
  passwordError,
  phoneError,
} from '../utils/auth.js'
import { actorTypeForRole, isStaffRole } from '../utils/adminRoles.js'
import { createSecureToken, hashSecureToken, resetTokenExpiry } from '../utils/secureTokens.js'
import { isEmailDeliveryConfigured, sendPasswordResetEmail } from '../services/emailService.js'

const authRouter = Router()
const SALT_ROUNDS = 12

function signUser(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: (user.role || 'CUSTOMER').toUpperCase(),
      av: Number(user.authVersion || 0),
    },
    jwtSecret(),
    { expiresIn: '7d' },
  )
}

function clientOrigin() {
  return String(env.CLIENT_URL || env.CLIENT_ORIGIN || 'https://www.svhub.shop').replace(/\/$/, '')
}

// 1. Register new customer account
authRouter.post('/register', authRegisterRateLimiter, async (req, res, next) => {
  try {
    const nameIssue = nameError(req.body?.name)
    const emailIssue = emailError(req.body?.email)
    const phoneIssue = phoneError(req.body?.phone)
    const passIssue = passwordError(req.body?.password)

    if (nameIssue) return fail(res, 400, 'invalid_name', nameIssue)
    if (emailIssue) return fail(res, 400, 'invalid_email', emailIssue)
    if (phoneIssue) return fail(res, 400, 'invalid_phone', phoneIssue)
    if (passIssue) return fail(res, 400, 'weak_password', passIssue)

    const email = normalizeEmail(req.body.email)
    const existing = await User.findOne({ email })
    if (existing) {
      return fail(res, 409, 'duplicate_email', 'An account with this email already exists. Try logging in.')
    }

    // Security check: Registration strictly creates CUSTOMER accounts.
    // Any incoming role parameter is discarded to prevent privilege escalation.
    const user = await User.create({
      name: String(req.body.name).trim(),
      email,
      phone: normalizePhone(req.body.phone),
      passwordHash: await bcrypt.hash(String(req.body.password), SALT_ROUNDS),
      provider: 'PASSWORD',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    })

    recordAuditLog({
      action: 'REGISTER',
      actorType: 'CUSTOMER',
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
    })

    return res.status(201).json({
      success: true,
      user: user.toPublic(),
      data: user.toPublic(),
      token: signUser(user),
    })
  } catch (error) {
    next(error)
  }
})

// 2. Customer & Staff Login (Canonical Unified Login)
authRouter.post('/login', authLoginRateLimiter, async (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? '')
    const identifierIssue = loginIdentifierError(identifier)
    if (identifierIssue) return fail(res, 400, 'invalid_identifier', identifierIssue)
    if (!req.body?.password) return fail(res, 400, 'invalid_password', 'Enter your password.')

    const user = identifier.includes('@')
      ? await User.findOne({ email: normalizeEmail(identifier) })
      : await User.findOne({ phone: normalizePhone(identifier) })

    if (user && !user.passwordHash) {
      recordAuditLog({
        action: 'LOGIN_FAILURE',
        actorType: 'CUSTOMER',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'FAILURE',
        reason: 'Google-only account attempted password login',
        req,
      })
      return fail(
        res,
        401,
        'google_only',
        'This account uses Google Sign-In. Continue with Google to log in.',
      )
    }

    const ok = user ? await bcrypt.compare(String(req.body.password), user.passwordHash) : false

    if (!user || !ok) {
      recordAuditLog({
        action: 'LOGIN_FAILURE',
        actorType: 'ANONYMOUS',
        actorEmail: identifier.includes('@') ? normalizeEmail(identifier) : null,
        resourceType: 'USER',
        result: 'FAILURE',
        reason: 'Invalid credentials',
        req,
      })
      return fail(
        res,
        401,
        'invalid_credentials',
        'That email or mobile number and password didn’t match. Please try again.',
      )
    }

    const status = String(user.status || 'ACTIVE').toUpperCase()
    if (status === 'SUSPENDED' || status === 'INACTIVE') {
      recordAuditLog({
        action: 'LOGIN_FAILURE',
        actorType: 'CUSTOMER',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'DENIED',
        reason: `Account status is ${status}`,
        req,
      })
      return fail(
        res,
        403,
        'account_inactive',
        'Your account has been deactivated. Please contact customer care.',
      )
    }

    user.lastLoginAt = new Date()
    await user.save()

    recordAuditLog({
      action: 'LOGIN_SUCCESS',
      actorType: actorTypeForRole(user.role),
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
      metadata: isStaffRole(user.role) ? { adminLogin: true, role: user.role } : undefined,
    })

    return res.json({
      success: true,
      user: user.toPublic(),
      data: user.toPublic(),
      token: signUser(user),
    })
  } catch (error) {
    next(error)
  }
})

// 3. Google OAuth Firebase Authentication
authRouter.post('/google', authGoogleRateLimiter, async (req, res, next) => {
  try {
    const idToken = String(req.body?.idToken || '')
    if (!idToken) {
      return fail(res, 400, 'invalid_token', 'Google Sign-In did not return a valid token.')
    }
    if (!isFirebaseAdminConfigured()) {
      return fail(res, 503, 'config', 'Google Sign-In is not configured on the server.')
    }

    let decoded
    try {
      decoded = await verifyGoogleIdToken(idToken)
    } catch (error) {
      console.error('Google token verify failed:', error.message)
      recordAuditLog({
        action: 'LOGIN_FAILURE',
        actorType: 'ANONYMOUS',
        resourceType: 'USER',
        result: 'FAILURE',
        reason: 'Google token verification failed',
        req,
      })
      return fail(res, 401, 'invalid_token', 'Google Sign-In could not be verified. Please try again.')
    }

    const email = normalizeEmail(decoded.email)
    if (!email) {
      return fail(res, 400, 'invalid_email', 'Google did not provide an email address for this account.')
    }
    if (decoded.firebase?.sign_in_provider && decoded.firebase.sign_in_provider !== 'google.com') {
      return fail(res, 401, 'invalid_token', 'This sign-in method is not supported.')
    }

    const name = String(decoded.name || email.split('@')[0]).trim()
    const firebaseUid = decoded.uid
    let created = false

    let user = await User.findOne({ firebaseUid })
    if (!user) user = await User.findOne({ email })

    if (user) {
      if (!user.firebaseUid) user.firebaseUid = firebaseUid
      if (!user.name) user.name = name
      await user.save()
    } else {
      created = true
      user = await User.create({
        name,
        email,
        firebaseUid,
        provider: 'GOOGLE',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      })
    }

    const status = String(user.status || 'ACTIVE').toUpperCase()
    if (status === 'SUSPENDED' || status === 'INACTIVE') {
      recordAuditLog({
        action: 'LOGIN_FAILURE',
        actorType: 'CUSTOMER',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'DENIED',
        reason: `Account status is ${status}`,
        req,
      })
      return fail(res, 403, 'account_inactive', 'Your account has been deactivated. Please contact support.')
    }

    user.lastLoginAt = new Date()
    await user.save()

    recordAuditLog({
      action: created ? 'REGISTER' : 'GOOGLE_LOGIN',
      actorType: actorTypeForRole(user.role),
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      metadata: { method: 'GOOGLE' },
      req,
    })

    return res.json({
      success: true,
      user: user.toPublic(),
      data: user.toPublic(),
      token: signUser(user),
      created,
    })
  } catch (error) {
    next(error)
  }
})

// 4. Session & Identity Restoration: GET /api/auth/me (NEW in Phase 1.1)
authRouter.get('/me', requireAuth, async (req, res) => {
  return res.json({
    success: true,
    user: req.user.toPublic(),
    data: req.user.toPublic(),
  })
})

// 5. Update Customer Profile
authRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const user = req.user
    const nameIssue = nameError(req.body?.name)
    const emailIssue = emailError(req.body?.email)
    const phoneIssue = phoneError(req.body?.phone)

    if (nameIssue) return fail(res, 400, 'invalid_name', nameIssue)
    if (emailIssue) return fail(res, 400, 'invalid_email', emailIssue)
    if (phoneIssue) return fail(res, 400, 'invalid_phone', phoneIssue)

    const email = normalizeEmail(req.body.email)
    if (email !== user.email) {
      const taken = await User.findOne({ email, _id: { $ne: user._id } })
      if (taken) {
        return fail(res, 409, 'duplicate_email', 'An account with this email already exists.')
      }
    }

    const currentPassword = String(req.body?.currentPassword ?? '')
    const newPassword = String(req.body?.newPassword ?? req.body?.password ?? '')
    const changingPassword = Boolean(currentPassword || newPassword)

    if (changingPassword) {
      if (user.passwordHash) {
        if (!currentPassword) {
          return fail(res, 400, 'invalid_password', 'Enter your current password.')
        }
        const matches = await bcrypt.compare(currentPassword, user.passwordHash)
        if (!matches) {
          return fail(
            res,
            401,
            'invalid_credentials',
            'That current password didn’t match. Please try again.',
          )
        }
      }

      const passIssue = passwordError(newPassword)
      if (passIssue) return fail(res, 400, 'weak_password', passIssue)

      if (user.passwordHash && currentPassword && newPassword === currentPassword) {
        return fail(
          res,
          400,
          'same_password',
          'Choose a new password that’s different from your current one.',
        )
      }

      user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)
    }

    // Update allowable profile fields (role and status cannot be updated here)
    user.name = String(req.body.name).trim()
    user.email = email
    user.phone = normalizePhone(req.body.phone)
    await user.save()

    return res.json({
      success: true,
      user: user.toPublic(),
      data: user.toPublic(),
    })
  } catch (error) {
    next(error)
  }
})

// 6. Request Password Reset Link (no email enumeration; never return token)
authRouter.post('/forgot-password', authPasswordResetRateLimiter, async (req, res, next) => {
  try {
    const emailIssue = emailError(req.body?.email)
    if (emailIssue) return fail(res, 400, 'invalid_email', emailIssue)

    const email = normalizeEmail(req.body.email)
    const user = await User.findOne({ email })

    const generic = {
      success: true,
      message:
        'If an account exists for that email, password reset instructions have been sent. Check your inbox.',
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    }

    if (!user || !user.passwordHash) {
      recordAuditLog({
        action: 'PASSWORD_RESET_REQUEST',
        actorType: 'ANONYMOUS',
        actorEmail: email,
        resourceType: 'USER',
        result: 'INFO',
        reason: 'Reset requested for unknown or passwordless account (no enumeration)',
        req,
      })
      return res.json(generic)
    }

    const token = createSecureToken()
    user.resetTokenHash = hashSecureToken(token)
    user.resetTokenExpires = resetTokenExpiry()
    await user.save()

    const resetUrl = `${clientOrigin()}/reset-password?token=${encodeURIComponent(token)}`
    const emailResult = await sendPasswordResetEmail({ to: email, resetUrl })

    recordAuditLog({
      action: 'PASSWORD_RESET_REQUEST',
      actorType: actorTypeForRole(user.role),
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
      metadata: { emailSent: Boolean(emailResult.sent) },
    })

    return res.json(generic)
  } catch (error) {
    next(error)
  }
})

// 7. Validate Password Reset Token
authRouter.get('/reset-password', async (req, res, next) => {
  try {
    const token = String(req.query.token || '')
    if (!token) {
      return fail(res, 400, 'invalid_token', 'This reset link is missing or incomplete.')
    }

    const user = await User.findOne({
      resetTokenHash: hashSecureToken(token),
      resetTokenExpires: { $gt: new Date() },
    })

    if (!user) {
      return fail(res, 400, 'invalid_token', 'This reset link is invalid or has expired. Request a new one.')
    }

    return res.json({
      success: true,
      email: user.email,
    })
  } catch (error) {
    next(error)
  }
})

// 8. Confirm Password Reset
authRouter.post('/reset-password', authPasswordResetRateLimiter, async (req, res, next) => {
  try {
    const token = String(req.body?.token || '')
    const passIssue = passwordError(req.body?.password)
    if (!token) return fail(res, 400, 'invalid_token', 'This reset link is missing or incomplete.')
    if (passIssue) return fail(res, 400, 'weak_password', passIssue)

    const user = await User.findOne({
      resetTokenHash: hashSecureToken(token),
      resetTokenExpires: { $gt: new Date() },
    })

    if (!user) {
      recordAuditLog({
        action: 'PASSWORD_RESET_SUCCESS',
        actorType: 'ANONYMOUS',
        resourceType: 'USER',
        result: 'FAILURE',
        reason: 'Expired or invalid reset token',
        req,
      })
      return fail(res, 400, 'expired_token', 'This reset link is invalid or has expired. Request a new one.')
    }

    user.passwordHash = await bcrypt.hash(String(req.body.password), SALT_ROUNDS)
    user.resetTokenHash = ''
    user.resetTokenExpires = null
    user.authVersion = Number(user.authVersion || 0) + 1
    await user.save()

    recordAuditLog({
      action: 'PASSWORD_RESET_SUCCESS',
      actorType: actorTypeForRole(user.role),
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
    })

    if (isStaffRole(user.role)) {
      recordAuditLog({
        action: 'ADMIN_PASSWORD_CHANGED',
        actorType: 'ADMIN',
        actorId: user._id,
        actorEmail: user.email,
        resourceType: 'USER',
        resourceId: String(user._id),
        result: 'SUCCESS',
        reason: 'Password reset completed',
        req,
      })
    }

    return res.json({
      success: true,
      email: user.email,
      message: 'Password has been reset successfully. You can now log in.',
    })
  } catch (error) {
    next(error)
  }
})

// 9. Logout
authRouter.post('/logout', requireAuth, (req, res) => {
  recordAuditLog({
    action: 'LOGOUT',
    actorType: actorTypeForRole(req.user?.role),
    actorId: req.user?._id,
    actorEmail: req.user?.email,
    resourceType: 'USER',
    resourceId: String(req.user?._id),
    result: 'SUCCESS',
    req,
  })
  return res.json({
    success: true,
    message: 'Logged out successfully.',
  })
})

export { authRouter }
