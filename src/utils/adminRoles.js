/**
 * Admin role / permission helpers (server-authoritative).
 *
 * Roles:
 * - CUSTOMER — storefront only
 * - ADMIN — store operations (products, orders, coupons later, settings)
 * - SUPER_ADMIN — everything ADMIN can do + manage admin access
 */

export const STAFF_ROLES = Object.freeze(['ADMIN', 'SUPER_ADMIN'])
export const ADMIN_ASSIGNABLE_ROLES = Object.freeze(['ADMIN', 'SUPER_ADMIN'])

export const PERMISSIONS = Object.freeze({
  DASHBOARD_VIEW: 'dashboard:view',
  PRODUCTS_MANAGE: 'products:manage',
  CATEGORIES_MANAGE: 'categories:manage',
  ORDERS_MANAGE: 'orders:manage',
  CUSTOMERS_MANAGE: 'customers:manage',
  INVENTORY_MANAGE: 'inventory:manage',
  SETTINGS_MANAGE: 'settings:manage',
  COUPONS_MANAGE: 'coupons:manage',
  ACCESS_MANAGE: 'access:manage',
  AUDIT_VIEW: 'audit:view',
})

const ADMIN_PERMISSIONS = Object.freeze([
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.PRODUCTS_MANAGE,
  PERMISSIONS.CATEGORIES_MANAGE,
  PERMISSIONS.ORDERS_MANAGE,
  PERMISSIONS.CUSTOMERS_MANAGE,
  PERMISSIONS.INVENTORY_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.COUPONS_MANAGE,
])

const SUPER_ADMIN_PERMISSIONS = Object.freeze([
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.ACCESS_MANAGE,
  PERMISSIONS.AUDIT_VIEW,
])

export function normalizeRole(role) {
  return String(role || 'CUSTOMER').toUpperCase()
}

export function isStaffRole(role) {
  return STAFF_ROLES.includes(normalizeRole(role))
}

export function isSuperAdminRole(role) {
  return normalizeRole(role) === 'SUPER_ADMIN'
}

export function isAssignableAdminRole(role) {
  return ADMIN_ASSIGNABLE_ROLES.includes(normalizeRole(role))
}

export function permissionsForRole(role) {
  const normalized = normalizeRole(role)
  if (normalized === 'SUPER_ADMIN') return [...SUPER_ADMIN_PERMISSIONS]
  if (normalized === 'ADMIN') return [...ADMIN_PERMISSIONS]
  return []
}

export function hasPermission(role, permission) {
  return permissionsForRole(role).includes(permission)
}

export function actorTypeForRole(role) {
  return isStaffRole(role) ? 'ADMIN' : 'CUSTOMER'
}

/** Mongo filter: customers only (exclude all staff). */
export function customerRoleFilter() {
  return { role: { $nin: STAFF_ROLES } }
}

export function roleLabel(role) {
  const normalized = normalizeRole(role)
  if (normalized === 'SUPER_ADMIN') return 'Super Admin'
  if (normalized === 'ADMIN') return 'Admin'
  return 'Customer'
}
