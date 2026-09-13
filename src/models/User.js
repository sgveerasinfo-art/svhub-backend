import mongoose from 'mongoose'
import { permissionsForRole, roleLabel } from '../utils/adminRoles.js'

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    passwordHash: {
      type: String,
      default: '',
    },
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    provider: {
      type: String,
      enum: ['PASSWORD', 'GOOGLE', 'password', 'google'],
      default: 'PASSWORD',
      set: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
    },
    role: {
      type: String,
      enum: {
        values: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'],
        message: '{VALUE} is not a valid role',
      },
      default: 'CUSTOMER',
      index: true,
      set: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
    },
    status: {
      type: String,
      enum: {
        values: ['ACTIVE', 'VIP', 'INACTIVE', 'SUSPENDED'],
        message: '{VALUE} is not a valid account status',
      },
      default: 'ACTIVE',
      index: true,
      set: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
    },
    /** Bumped on password change / deactivate to invalidate existing JWTs. */
    authVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    resetTokenHash: {
      type: String,
      default: '',
    },
    resetTokenExpires: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

userSchema.methods.toPublic = function toPublic() {
  const role = (this.role || 'CUSTOMER').toUpperCase()
  return {
    id: String(this._id),
    name: this.name,
    email: this.email,
    phone: this.phone || '',
    role,
    roleLabel: roleLabel(role),
    status: (this.status || 'ACTIVE').toUpperCase(),
    permissions: permissionsForRole(role),
    hasPassword: Boolean(this.passwordHash),
    provider: (this.provider || 'PASSWORD').toUpperCase(),
    lastLoginAt: this.lastLoginAt || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

userSchema.methods.toAdminListItem = function toAdminListItem() {
  const role = (this.role || 'CUSTOMER').toUpperCase()
  return {
    id: String(this._id),
    name: this.name,
    email: this.email,
    role,
    roleLabel: roleLabel(role),
    status: (this.status || 'ACTIVE').toUpperCase(),
    lastLoginAt: this.lastLoginAt || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    hasPassword: Boolean(this.passwordHash),
  }
}

export const User = mongoose.model('User', userSchema)
