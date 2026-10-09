// The v1 permission catalog (docs/SPEC.md §9). This is the single source of truth: the seed
// script syncs these rows into the `permissions` table, and application code imports this file
// directly rather than querying permission keys as magic strings.
//
// IMPORTANT — adding a key here is NOT enough on its own: nothing automatically re-runs
// `pnpm --filter @ammari/db db:seed` against a real database when this array changes (there is
// no CI/deploy step that does it today), so a new permission added here can sit invisible to
// every already-provisioned super_admin/owner on dev/prod/a human's local db indefinitely,
// exactly as happened with "orders.manage" after it was first added here. Migrations DO run
// reliably on every environment (docs/SPEC.md §2.3), so every new permission key must ALSO ship
// with a migration that idempotently (ON CONFLICT DO NOTHING) inserts the row into `permissions`
// and grants it to `super_admin` (always) and `owner` (unless it's in
// OWNER_EXCLUDED_PERMISSION_KEYS below) — see migration 0012 for the pattern.
//
// (Test/e2e databases never show this gap: packages/db/test/e2e-db.ts and
// test/global-setup.ts's own seed step re-run `seed()` from scratch on every run, so they always
// see the current PERMISSIONS array. A real dev/prod database, or a developer's own local
// `ammari` db, does not get that for free.)

export interface PermissionDefinition {
  key: string;
  group: string;
  description: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  { key: "overview.view", group: "overview", description: "View the overview dashboard" },
  { key: "orders.view", group: "orders", description: "View orders" },
  { key: "orders.manage", group: "orders", description: "Record manual orders and change order status" },
  { key: "orders.import", group: "orders", description: "Import Shopee/TikTok order and income exports" },
  { key: "packing.print_cards", group: "packing", description: "Print thank-you cards during packing" },
  { key: "stock.view", group: "stock", description: "View stock levels and movements" },
  { key: "stock.adjust", group: "stock", description: "Record manual stock adjustments" },
  { key: "production.manage", group: "production", description: "Manage production batches" },
  { key: "products.manage", group: "products", description: "Manage products, variants, and images" },
  { key: "inventory.view", group: "inventory", description: "View accessory and fabric stock levels and ledgers" },
  {
    key: "inventory.manage",
    group: "inventory",
    description: "Manage accessories, record purchases, void purchases, and adjust raw-material stock",
  },
  {
    key: "ads_expenses.manage",
    group: "ads_expenses",
    description: "Record ad spend and expenses",
  },
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
