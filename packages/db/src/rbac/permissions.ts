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
  // docs/plans/suppliers-goods-receipt.md D10 — posting a goods receipt, separate from
  // inventory.manage so the person standing next to the box can receive without being able to
  // edit, close or reverse documents. Shipped to existing databases by migration 0024. Since S4
  // (migration 0025) it also receives a posted production batch's output.
  { key: "inventory.receive", group: "inventory", description: "Receive goods against purchase documents and production batches" },
  {
    key: "ads_expenses.manage",
    group: "ads_expenses",
    description: "Record ad spend and expenses",
  },
  { key: "finance.view_profit", group: "finance", description: "View cost, profit, and payout figures" },
  // docs/plans/purchase-payments.md P10 — writing money records (and opening their proofs) is a
  // stronger act than the read-only finance.view_profit, and the person receiving goods should not
  // by default be able to mark a supplier paid. Every use also requires finance.view_profit (§7).
  // Shipped to existing databases by migration 0038.
  {
    key: "supplier_payments.manage",
    group: "finance",
    description: "Record and void supplier payments, and view payment proofs",
  },
  { key: "settings.manage", group: "settings", description: "Manage targets, cost assumptions, and settings" },
  { key: "customers.view", group: "customers", description: "View customers" },
  { key: "vouchers.void", group: "vouchers", description: "Void a voucher" },
  {
    key: "content.manage",
    group: "content",
    description:
      "Manage storefront content: homepage sections, product publish/description/size chart, size charts",
  },
  { key: "staff.manage", group: "staff", description: "Manage staff accounts" },
  { key: "roles.manage", group: "roles", description: "Manage roles and role permissions" },
  { key: "audit_log.view", group: "audit_log", description: "View the audit log" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const SUPER_ADMIN_ROLE_KEY = "super_admin";
export const OWNER_ROLE_KEY = "owner";

/** Permissions the `owner` role does NOT get by default (docs/SPEC.md §9). Computed sets below
 * derive from this instead of a duplicated static list, so both stay correct as the catalog
 * grows. `staff.manage` left this list in migration 0041 (docs/plans/roles-staff.md, owner
 * answer 2): the owner manages staff, within the subset rule, but never roles or the audit log. */
export const OWNER_EXCLUDED_PERMISSION_KEYS: readonly PermissionKey[] = [
  "roles.manage",
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

export interface PredefinedRoleDefinition {
  key: string;
  name: string;
  description: string;
  permissionKeys: readonly PermissionKey[];
}

/** The starting set of non-system roles (docs/plans/roles-staff.md §6). Shipped to every
 * database by migration 0041, which inserts each role and its grants only if the role key does
 * not exist yet; `seed.ts` does the same, insert-only, for test/e2e databases reset by TRUNCATE.
 * Neither ever rewrites a role that already exists, so a super_admin's later edit in the admin UI
 * survives. Keep this list and migration 0041 in sync by hand (migration-0041.test.ts checks). */
export const PREDEFINED_ROLES: readonly PredefinedRoleDefinition[] = [
  {
    key: "packing_warehouse",
    name: "Packing/Gudang",
    description: "Antrean packing, cetak kartu dan stiker, tandai dikirim, lihat stok, terima barang datang.",
    permissionKeys: ["orders.view", "orders.manage", "packing.print_cards", "stock.view", "inventory.view", "inventory.receive"],
  },
  {
    key: "content_admin",
    name: "Admin Konten",
    description: "Konten toko online: beranda, halaman info, tabel ukuran, deskripsi produk.",
    permissionKeys: ["content.manage", "stock.view"],
  },
  {
    key: "customer_service",
    name: "CS/Pesanan",
    description: "Pesanan WhatsApp/Instagram/offline, status pesanan, data pelanggan, cek stok.",
    permissionKeys: ["overview.view", "orders.view", "orders.manage", "customers.view", "stock.view"],
  },
  {
    key: "finance",
    name: "Keuangan",
    description: "Laba, biaya, pembayaran supplier, impor marketplace. Tidak mengubah produk atau stok.",
    permissionKeys: [
      "overview.view",
      "orders.view",
      "orders.import",
      "inventory.view",
      "ads_expenses.manage",
      "finance.view_profit",
      "supplier_payments.manage",
    ],
  },
] as const;

/** Every staff/role write takes `pg_advisory_xact_lock(hashtext(STAFF_ACCESS_LOCK_KEY))` first
 * (apps/admin lib/staff), and so does migration 0041's last-super_admin trigger, with this exact
 * literal. One lock serializes all staff access changes, so "is this the last active super_admin"
 * can never be decided on a stale count (write skew). Changing it means a new migration too. */
export const STAFF_ACCESS_LOCK_KEY = "ammari.staff_access";
