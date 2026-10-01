// The v1 permission catalog (docs/SPEC.md §9). This is the single source of truth: the seed
// script syncs these rows into the `permissions` table, and application code imports this file
// directly rather than querying permission keys as magic strings.

export interface PermissionDefinition {
  key: string;
  group: string;
  description: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  { key: "orders.view", group: "orders", description: "View orders" },
  { key: "orders.import", group: "orders", description: "Import Shopee/TikTok order and income exports" },
  { key: "packing.print_cards", group: "packing", description: "Print thank-you cards during packing" },
  { key: "stock.view", group: "stock", description: "View stock levels and movements" },
  { key: "stock.adjust", group: "stock", description: "Record manual stock adjustments" },
  { key: "production.manage", group: "production", description: "Manage production batches" },
  { key: "products.manage", group: "products", description: "Manage products, variants, and images" },
  { key: "finance.view_profit", group: "finance", description: "View cost, profit, and payout figures" },
  { key: "settings.manage", group: "settings", description: "Manage targets, cost assumptions, and settings" },
  { key: "customers.view", group: "customers", description: "View customers" },
  { key: "vouchers.void", group: "vouchers", description: "Void a voucher" },
  { key: "staff.manage", group: "staff", description: "Manage staff accounts" },
  { key: "roles.manage", group: "roles", description: "Manage roles and role permissions" },
  { key: "audit_log.view", group: "audit_log", description: "View the audit log" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const SUPER_ADMIN_ROLE_KEY = "super_admin";
export const OWNER_ROLE_KEY = "owner";

/** Permissions the `owner` role does NOT get by default (docs/SPEC.md §9). Computed sets below
 * derive from this instead of a duplicated static list, so both stay correct as the catalog
 * grows. */
export const OWNER_EXCLUDED_PERMISSION_KEYS: readonly PermissionKey[] = [
  "roles.manage",
  "staff.manage",
  "audit_log.view",
];

export function superAdminDefaultPermissionKeys(): PermissionKey[] {
  return PERMISSIONS.map((permission) => permission.key);
}

export function ownerDefaultPermissionKeys(): PermissionKey[] {
  return PERMISSIONS.filter(
    (permission) => !OWNER_EXCLUDED_PERMISSION_KEYS.includes(permission.key),
  ).map((permission) => permission.key);
}
