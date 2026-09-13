import bcrypt from 'bcryptjs'
import { User } from '../models/User.js'
import { AdminInvitation } from '../models/AdminInvitation.js'
import { AuditLog } from '../models/AuditLog.js'
import { env } from '../config/env.js'
import { fail, nameError, emailError, normalizeEmail, passwordError } from '../utils/auth.js'
import {
  ADMIN_ASSIGNABLE_ROLES,
  isAssignableAdminRole,
  isStaffRole,
  isSuperAdminRole,
  normalizeRole,
  roleLabel,
  STAFF_ROLES,
} from '../utils/adminRoles.js'
import {
  createSecureToken,
  hashSecureToken,
  invitationTokenExpiry,
} from '../utils/secureTokens.js'
import { isEmailDeliveryConfigured, sendAdminInvitationEmail } from '../services/emailService.js'
import { recordAuditLog } from '../services/auditLogger.js'

const SALT_ROUNDS = 12

function clientOrigin() {
  return String(env.CLIENT_URL || env.CLIENT_ORIGIN || 'https://www.svhub.shop').replace(/\/$/, '')
}

function setupUrlForToken(token) {
  return `${clientOrigin()}/admin/setup?token=${encodeURIComponent(token)}`
}

/**
 * Include one-time setup URL for the inviting Super Admin only when email
 * delivery is not configured (bootstrap / ops recovery). Never log the token.
 */
function maybeSetupUrl(token) {
  if (isEmailDeliveryConfigured()) return undefined
  return setupUrlForToken(token)
}

async function countActiveSuperAdmins(excludeUserId = null) {
  const filter = {
    role: 'SUPER_ADMIN',
    status: { $in: ['ACTIVE', 'VIP'] },
  }
  if (excludeUserId) {
    filter._id = { $ne: excludeUserId }
  }
  return User.countDocuments(filter)
}

async function revokePendingInvitesForUser(userId) {
  await AdminInvitation.updateMany(
    { userId, usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
}

async function createInvitationRecord({ user, name, role, invitedBy }) {
  const token = createSecureToken()
  const invite = await AdminInvitation.create({
    email: user.email,
    name: name || user.name,
    role: normalizeRole(role),
    userId: user._id,
    tokenHash: hashSecureToken(token),
    expiresAt: invitationTokenExpiry(),
    invitedBy: invitedBy._id,
  })
  return { invite, token }
}

export async function listAdminUsers(req, res, next) {
  try {
    const users = await User.find({ role: { $in: STAFF_ROLES } })
      .select('-passwordHash -resetTokenHash')
      .sort({ createdAt: 1 })

    return res.json({
      success: true,
      data: users.map((user) => user.toAdminListItem()),
    })
  } catch (error) {
    next(error)
  }
}

export async function listPendingInvitations(req, res, next) {
  try {
    const invites = await AdminInvitation.find({
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(100)

    return res.json({
      success: true,
      data: invites.map((invite) => invite.toPublic()),
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    })
  } catch (error) {
    next(error)
  }
}

export async function createAdminInvitation(req, res, next) {
  try {
    const nameIssue = nameError(req.body?.name)
    const emailIssue = emailError(req.body?.email)
    if (nameIssue) return fail(res, 400, 'invalid_name', nameIssue)
    if (emailIssue) return fail(res, 400, 'invalid_email', emailIssue)

    const role = normalizeRole(req.body?.role || 'ADMIN')
    if (!isAssignableAdminRole(role)) {
      return fail(res, 400, 'invalid_role', 'Role must be Admin or Super Admin.')
    }

    const email = normalizeEmail(req.body.email)
    const name = String(req.body.name).trim()

    let user = await User.findOne({ email })
    if (user && !isStaffRole(user.role)) {
      return fail(
        res,
        409,
        'email_is_customer',
        'This email belongs to a customer account. Use a different email for admin access.',
      )
    }

    if (user && String(user.status).toUpperCase() === 'ACTIVE' && user.passwordHash) {
      return fail(res, 409, 'admin_exists', 'An active admin already exists for this email.')
    }

    if (!user) {
      user = await User.create({
        name,
        email,
        phone: '',
        passwordHash: '',
        provider: 'PASSWORD',
        role,
        status: 'INACTIVE',
        authVersion: 0,
      })
    } else {
      user.name = name
      user.role = role
      user.status = 'INACTIVE'
      user.passwordHash = ''
      user.authVersion = Number(user.authVersion || 0) + 1
      await user.save()
      await revokePendingInvitesForUser(user._id)
    }

    const { invite, token } = await createInvitationRecord({
      user,
      name,
      role,
      invitedBy: req.user,
    })

    const setupUrl = setupUrlForToken(token)
    const emailResult = await sendAdminInvitationEmail({
      to: email,
      name,
      setupUrl,
    })

    recordAuditLog({
      action: 'ADMIN_INVITATION_CREATED',
      actorType: 'ADMIN',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
      metadata: {
        targetEmail: email,
        targetRole: role,
        invitationId: String(invite._id),
        emailSent: Boolean(emailResult.sent),
      },
    })

    const response = {
      success: true,
      data: {
        invitation: invite.toPublic(),
        user: user.toAdminListItem(),
        emailSent: Boolean(emailResult.sent),
        emailDeliveryConfigured: isEmailDeliveryConfigured(),
      },
      message: emailResult.sent
        ? 'Invitation sent. The administrator must create their own password via the email link.'
        : 'Invitation created. Email delivery is not configured — copy the setup link shown once below.',
    }

    const bootstrapUrl = maybeSetupUrl(token)
    if (bootstrapUrl) {
      response.data.setupUrl = bootstrapUrl
    }

    return res.status(201).json(response)
  } catch (error) {
    next(error)
  }
}

export async function resendAdminInvitation(req, res, next) {
  try {
    const invite = await AdminInvitation.findById(req.params.id)
    if (!invite || invite.usedAt || invite.revokedAt) {
      return fail(res, 404, 'invitation_not_found', 'Invitation not found or no longer active.')
    }

    const user = await User.findById(invite.userId)
    if (!user || !isStaffRole(user.role)) {
      return fail(res, 404, 'admin_not_found', 'Admin account not found for this invitation.')
    }

    invite.revokedAt = new Date()
    await invite.save()

    const { invite: nextInvite, token } = await createInvitationRecord({
      user,
      name: invite.name || user.name,
      role: invite.role || user.role,
      invitedBy: req.user,
    })

    const setupUrl = setupUrlForToken(token)
    const emailResult = await sendAdminInvitationEmail({
      to: user.email,
      name: user.name,
      setupUrl,
    })

    recordAuditLog({
      action: 'ADMIN_INVITATION_CREATED',
      actorType: 'ADMIN',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      reason: 'Invitation resent',
      req,
      metadata: {
        previousInvitationId: String(invite._id),
        invitationId: String(nextInvite._id),
        emailSent: Boolean(emailResult.sent),
      },
    })

    const response = {
      success: true,
      data: {
        invitation: nextInvite.toPublic(),
        emailSent: Boolean(emailResult.sent),
        emailDeliveryConfigured: isEmailDeliveryConfigured(),
      },
    }
    const bootstrapUrl = maybeSetupUrl(token)
    if (bootstrapUrl) response.data.setupUrl = bootstrapUrl
    return res.json(response)
  } catch (error) {
    next(error)
  }
}

export async function revokeAdminInvitation(req, res, next) {
  try {
    const invite = await AdminInvitation.findById(req.params.id)
    if (!invite) {
      return fail(res, 404, 'invitation_not_found', 'Invitation not found.')
    }
    if (!invite.revokedAt && !invite.usedAt) {
      invite.revokedAt = new Date()
      await invite.save()
    }

    recordAuditLog({
      action: 'ADMIN_INVITATION_REVOKED',
      actorType: 'ADMIN',
      actorId: req.user._id,
      actorEmail: req.user.email,
      resourceType: 'USER',
      resourceId: String(invite.userId),
      result: 'SUCCESS',
      req,
      metadata: { invitationId: String(invite._id) },
    })

    return res.json({ success: true, data: invite.toPublic() })
  } catch (error) {
    next(error)
  }
}

export async function updateAdminUser(req, res, next) {
  try {
    const target = await User.findById(req.params.id)
    if (!target || !isStaffRole(target.role)) {
      return fail(res, 404, 'admin_not_found', 'Admin account not found.')
    }

    const nextRole = req.body?.role !== undefined ? normalizeRole(req.body.role) : null
    const nextStatus = req.body?.status !== undefined ? String(req.body.status).toUpperCase() : null
    const confirmSelfLock = Boolean(req.body?.confirmSelfLock)

    if (nextRole && !isAssignableAdminRole(nextRole)) {
      return fail(res, 400, 'invalid_role', 'Role must be Admin or Super Admin.')
    }
    if (nextStatus && !['ACTIVE', 'INACTIVE'].includes(nextStatus)) {
      return fail(res, 400, 'invalid_status', 'Status must be ACTIVE or INACTIVE.')
    }

    const isSelf = String(target._id) === String(req.user._id)
    const wasSuper = isSuperAdminRole(target.role)

    if (nextRole && nextRole !== normalizeRole(target.role)) {
      if (isSelf && wasSuper && nextRole === 'ADMIN' && !confirmSelfLock) {
        return fail(
          res,
          400,
          'confirm_self_demotion',
          'Confirm demoting your own Super Admin role by setting confirmSelfLock=true.',
        )
      }
      if (wasSuper && nextRole === 'ADMIN') {
        const remaining = await countActiveSuperAdmins(target._id)
        if (remaining < 1 && String(target.status).toUpperCase() === 'ACTIVE') {
          return fail(
            res,
            400,
            'last_super_admin',
            'Cannot demote the last active Super Admin. Promote another Super Admin first.',
          )
        }
      }
      const previousRole = normalizeRole(target.role)
      target.role = nextRole
      target.authVersion = Number(target.authVersion || 0) + 1
      recordAuditLog({
        action: 'ADMIN_ROLE_CHANGED',
        actorType: 'ADMIN',
        actorId: req.user._id,
        actorEmail: req.user.email,
        resourceType: 'USER',
        resourceId: String(target._id),
        result: 'SUCCESS',
        req,
        metadata: { from: previousRole, to: nextRole, targetEmail: target.email },
      })
    }

    if (nextStatus && nextStatus !== String(target.status).toUpperCase()) {
      if (nextStatus === 'INACTIVE') {
        if (isSelf && !confirmSelfLock) {
          return fail(
            res,
            400,
            'confirm_self_deactivate',
            'Confirm deactivating your own account by setting confirmSelfLock=true.',
          )
        }
        if (wasSuper && String(target.status).toUpperCase() === 'ACTIVE') {
          const remaining = await countActiveSuperAdmins(target._id)
          if (remaining < 1) {
            return fail(
              res,
              400,
              'last_super_admin',
              'Cannot deactivate the last active Super Admin.',
            )
          }
        }
        target.status = 'INACTIVE'
        target.authVersion = Number(target.authVersion || 0) + 1
        await revokePendingInvitesForUser(target._id)
        recordAuditLog({
          action: 'ADMIN_DEACTIVATED',
          actorType: 'ADMIN',
          actorId: req.user._id,
          actorEmail: req.user.email,
          resourceType: 'USER',
          resourceId: String(target._id),
          result: 'SUCCESS',
          req,
          metadata: { targetEmail: target.email },
        })
      } else if (nextStatus === 'ACTIVE') {
        if (!target.passwordHash) {
          return fail(
            res,
            400,
            'password_required',
            'This admin has not completed password setup. Resend an invitation instead.',
          )
        }
        target.status = 'ACTIVE'
        recordAuditLog({
          action: 'ADMIN_REACTIVATED',
          actorType: 'ADMIN',
          actorId: req.user._id,
          actorEmail: req.user.email,
          resourceType: 'USER',
          resourceId: String(target._id),
          result: 'SUCCESS',
          req,
          metadata: { targetEmail: target.email },
        })
      }
    }

    await target.save()

    return res.json({
      success: true,
      data: target.toAdminListItem(),
      assignableRoles: ADMIN_ASSIGNABLE_ROLES.map((value) => ({
        value,
        label: roleLabel(value),
      })),
    })
  } catch (error) {
    next(error)
  }
}

export async function listAccessAudit(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)
    const actions = [
      'ADMIN_INVITATION_CREATED',
      'ADMIN_INVITATION_REVOKED',
      'ADMIN_INVITATION_ACCEPTED',
      'ADMIN_DEACTIVATED',
      'ADMIN_REACTIVATED',
      'ADMIN_ROLE_CHANGED',
      'ADMIN_PASSWORD_CHANGED',
      'LOGIN_SUCCESS',
      'LOGIN_FAILURE',
      'PASSWORD_RESET_REQUEST',
      'PASSWORD_RESET_SUCCESS',
    ]

    const logs = await AuditLog.find({
      action: { $in: actions },
      $or: [{ resourceType: 'USER' }, { actorType: 'ADMIN' }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)

    return res.json({
      success: true,
      data: logs.map((entry) => ({
        id: String(entry._id),
        action: entry.action,
        actorEmail: entry.actorEmail,
        actorId: entry.actorId ? String(entry.actorId) : null,
        resourceId: entry.resourceId,
        result: entry.result,
        reason: entry.reason,
        metadata: entry.metadata || {},
        createdAt: entry.createdAt,
      })),
    })
  } catch (error) {
    next(error)
  }
}

export async function validateAdminSetupToken(req, res, next) {
  try {
    const token = String(req.query.token || '')
    if (!token) {
      return fail(res, 400, 'invalid_token', 'This setup link is missing or incomplete.')
    }

    const invite = await AdminInvitation.findOne({
      tokenHash: hashSecureToken(token),
    })

    if (!invite || invite.revokedAt) {
      return fail(res, 400, 'invalid_token', 'Invitation expired. Please request a new invitation.')
    }
    if (invite.usedAt) {
      return fail(res, 400, 'invitation_used', 'This invitation has already been used.')
    }
    if (!invite.expiresAt || invite.expiresAt.getTime() < Date.now()) {
      return fail(res, 400, 'invitation_expired', 'Invitation expired. Please request a new invitation.')
    }

    return res.json({
      success: true,
      data: {
        email: invite.email,
        name: invite.name,
        role: invite.role,
        roleLabel: roleLabel(invite.role),
        expiresAt: invite.expiresAt,
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function acceptAdminSetup(req, res, next) {
  try {
    const token = String(req.body?.token || '')
    const passIssue = passwordError(req.body?.password)
    if (!token) return fail(res, 400, 'invalid_token', 'This setup link is missing or incomplete.')
    if (passIssue) return fail(res, 400, 'weak_password', passIssue)

    const invite = await AdminInvitation.findOne({
      tokenHash: hashSecureToken(token),
    })

    if (!invite || invite.revokedAt) {
      return fail(res, 400, 'invalid_token', 'Invitation expired. Please request a new invitation.')
    }
    if (invite.usedAt) {
      return fail(res, 400, 'invitation_used', 'This invitation has already been used.')
    }
    if (!invite.expiresAt || invite.expiresAt.getTime() < Date.now()) {
      return fail(res, 400, 'invitation_expired', 'Invitation expired. Please request a new invitation.')
    }

    const user = await User.findById(invite.userId)
    if (!user || !isStaffRole(user.role)) {
      return fail(res, 400, 'invalid_token', 'Invitation expired. Please request a new invitation.')
    }

    user.passwordHash = await bcrypt.hash(String(req.body.password), SALT_ROUNDS)
    user.status = 'ACTIVE'
    user.role = normalizeRole(invite.role)
    user.provider = 'PASSWORD'
    user.authVersion = Number(user.authVersion || 0) + 1
    user.resetTokenHash = ''
    user.resetTokenExpires = null
    await user.save()

    invite.usedAt = new Date()
    await invite.save()

    await AdminInvitation.updateMany(
      {
        userId: user._id,
        _id: { $ne: invite._id },
        usedAt: null,
        revokedAt: null,
      },
      { $set: { revokedAt: new Date() } },
    )

    recordAuditLog({
      action: 'ADMIN_INVITATION_ACCEPTED',
      actorType: 'ADMIN',
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      req,
      metadata: { invitationId: String(invite._id) },
    })

    recordAuditLog({
      action: 'ADMIN_PASSWORD_CHANGED',
      actorType: 'ADMIN',
      actorId: user._id,
      actorEmail: user.email,
      resourceType: 'USER',
      resourceId: String(user._id),
      result: 'SUCCESS',
      reason: 'Password set via invitation',
      req,
    })

    return res.json({
      success: true,
      message: 'Password created successfully. You can now sign in to the admin panel.',
      data: {
        email: user.email,
      },
    })
  } catch (error) {
    next(error)
  }
}
