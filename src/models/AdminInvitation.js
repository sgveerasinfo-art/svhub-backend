import mongoose from 'mongoose'
import { roleLabel } from '../utils/adminRoles.js'

const adminInvitationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['ADMIN', 'SUPER_ADMIN'],
      required: true,
      set: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  },
)

adminInvitationSchema.index({ email: 1, usedAt: 1, revokedAt: 1 })

adminInvitationSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    email: this.email,
    name: this.name,
    role: this.role,
    roleLabel: roleLabel(this.role),
    userId: String(this.userId),
    expiresAt: this.expiresAt,
    usedAt: this.usedAt,
    revokedAt: this.revokedAt,
    status: this.revokedAt
      ? 'REVOKED'
      : this.usedAt
        ? 'USED'
        : this.expiresAt && this.expiresAt.getTime() < Date.now()
          ? 'EXPIRED'
          : 'PENDING',
    createdAt: this.createdAt,
  }
}

export const AdminInvitation = mongoose.model('AdminInvitation', adminInvitationSchema)
