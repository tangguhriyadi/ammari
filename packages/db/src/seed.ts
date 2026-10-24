import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db as defaultDb } from "./client";
import {
  channels,
  costAssumptions,
  costComponents,
  DEFAULT_PRODUCT_TYPE_CODE,
  HOMEPAGE_SECTION_KEYS,
  infoPages,
  permissions,
  productTypes,
  rolePermissions,
  roles,
  salesGoal,
  staffUsers,
  storefrontHomepageSections,
  storeSettings,
} from "./schema";
import type { ChannelId } from "./schema";
import {
  OWNER_ROLE_KEY,
  PERMISSIONS,
  SUPER_ADMIN_ROLE_KEY,
  ownerDefaultPermissionKeys,
  superAdminDefaultPermissionKeys,
} from "./rbac/permissions";

/** Accepts an injected `db` so tests can seed the isolated `ammari_test` database instead of
 * whatever DATABASE_URL points at (see test/global-setup.ts). */
type Database = typeof defaultDb;

const CHANNEL_NAMES: Record<ChannelId, string> = {
  shopee: "Shopee",
  tiktok: "TikTok Shop",
  web: "Main site",
  reseller: "Reseller",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  offline: "Offline",
};

async function upsertChannels(db: Database) {
  // Object.entries widens the key back to `string` regardless of CHANNEL_NAMES' own Record<ChannelId, ...>
  // type — cast back so `id` matches channels.id's `$type<ChannelId>()`.
  for (const [id, name] of Object.entries(CHANNEL_NAMES) as [ChannelId, string][]) {
    await db.insert(channels).values({ id, name }).onConflictDoUpdate({ target: channels.id, set: { name } });
  }
}

// Ensures the 4 fixed homepage section rows exist (migration 0019's own idempotent INSERT
// already does this for dev/prod) — ONLY re-synced here, never overwritten: onConflictDoNothing,
// not onConflictDoUpdate (unlike upsertChannels), because a row that already exists may hold
// real draft/published content an admin wrote, which a reseed must never clobber. This mirrors
// upsertChannels/syncPermissionCatalog's own "migration ships it, seed.ts also keeps a fresh
// local/test db in sync" dual mechanism (CLAUDE.md's database rule: ship in a migration, never
// ONLY in seed.ts) — needed because `packages/db/test/e2e-db.ts` TRUNCATEs every table on each
// e2e run and relies on THIS function, not a migration replay, to restore these 4 rows (a
// already-applied migration's own INSERT never runs again).
async function seedHomepageSections(db: Database) {
  for (const key of HOMEPAGE_SECTION_KEYS) {
    await db.insert(storefrontHomepageSections).values({ key }).onConflictDoNothing({ target: storefrontHomepageSections.key });
  }
}

// Same "migration ships it, seed.ts also keeps a truncate-and-reseed test db in sync" dual
// mechanism as seedHomepageSections above — migration 0020's own idempotent INSERT seeds these
// 5 rows for dev/prod, but packages/db/test/e2e-db.ts's TRUNCATE wipes them on every e2e run and
// relies on THIS function (not a migration replay) to restore them. onConflictDoNothing, not
// onConflictDoUpdate — a row that already exists may hold a real owner edit (a published page),
// which a reseed must never clobber. Text matches migration 0020's seed EXACTLY (the current
// hard-coded placeholder apps/web/src/app/privacy-policy/page.tsx and terms-of-service/page.tsx
// used before this CMS existed) — keep the two in sync by hand if either ever changes.
const PRIVACY_POLICY_PLACEHOLDER_HTML =
  "<p>Konten kebijakan privasi Ammari akan dilengkapi di sini sebelum peluncuran. Halaman ini menjelaskan bagaimana Ammari mengumpulkan, menggunakan, dan melindungi data pribadimu sesuai Undang-Undang Pelindungan Data Pribadi (UU PDP).</p>";
const TERMS_OF_SERVICE_PLACEHOLDER_HTML =
  "<p>Syarat dan ketentuan penggunaan layanan Ammari, termasuk aturan voucher dan belanja di ammari.id, akan dilengkapi di sini sebelum peluncuran.</p>";

async function seedInfoPages(db: Database) {
  const rows: (typeof infoPages.$inferInsert)[] = [
    { slug: "privacy-policy", title: "Kebijakan Privasi", draftBody: PRIVACY_POLICY_PLACEHOLDER_HTML, publishedBody: PRIVACY_POLICY_PLACEHOLDER_HTML, publishedAt: new Date() },
    { slug: "terms-of-service", title: "Syarat & Ketentuan", draftBody: TERMS_OF_SERVICE_PLACEHOLDER_HTML, publishedBody: TERMS_OF_SERVICE_PLACEHOLDER_HTML, publishedAt: new Date() },
    { slug: "returns-exchange", title: "Pengembalian & Penukaran", draftBody: "" },
    { slug: "how-to-order", title: "Cara Pemesanan", draftBody: "" },
    { slug: "shipping", title: "Pengiriman", draftBody: "" },
  ];
  for (const row of rows) {
    await db.insert(infoPages).values(row).onConflictDoNothing({ target: infoPages.slug });
  }
}

// Same reasoning as seedInfoPages above — store_settings is a singleton (id fixed to 1 by its
// own CHECK), migration 0020 inserts the one row with every field null, and this function
// restores that same row after a truncate-and-reseed test run. onConflictDoNothing: a row that
// already exists may hold the owner's real WhatsApp/email/address, never overwritten here.
async function seedStoreSettings(db: Database) {
  await db.insert(storeSettings).values({ id: 1 }).onConflictDoNothing({ target: storeSettings.id });
}

async function syncPermissionCatalog(db: Database) {
  for (const permission of PERMISSIONS) {
    await db
      .insert(permissions)
      .values(permission)
      .onConflictDoUpdate({
        target: permissions.key,
        set: { description: permission.description, group: permission.group },
      });
  }
}

async function upsertSystemRole(
  db: Database,
  key: string,
  name: string,
  description: string,
  permissionKeys: readonly string[],
) {
  const [role] = await db
    .insert(roles)
    .values({ key, name, description, isSystem: true })
    .onConflictDoUpdate({ target: roles.key, set: { name, description, isSystem: true } })
    .returning();
  if (!role) throw new Error(`failed to upsert role "${key}"`);

  const permissionRows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.key, [...permissionKeys]));
  const desiredPermissionIds = permissionRows.map((p) => p.id);

  // Insert-then-prune, not delete-then-insert: two packages' test suites (packages/db,
  // packages/auth) each run this seed independently against the same shared `ammari_test`
  // database, so this must be safe under concurrent invocation — the same "never check-then-
  // write" rule CLAUDE.md states for voucher claim/redemption/order import applies here too.
  // `onConflictDoNothing` makes the insert race-safe; the final DELETE's own WHERE clause (not
  // a prior read) makes the prune race-safe, since a second concurrent run finding nothing left
  // to delete is a no-op, not an error.
  if (desiredPermissionIds.length > 0) {
    await db
      .insert(rolePermissions)
      .values(desiredPermissionIds.map((permissionId) => ({ roleId: role.id, permissionId })))
      .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
  }
  await db
    .delete(rolePermissions)
    .where(
      desiredPermissionIds.length > 0
        ? and(eq(rolePermissions.roleId, role.id), notInArray(rolePermissions.permissionId, desiredPermissionIds))
        : eq(rolePermissions.roleId, role.id),
    );
}

async function seedSystemRoles(db: Database) {
  await upsertSystemRole(
    db,
    SUPER_ADMIN_ROLE_KEY,
    "Super Admin",
    "Every permission, including roles.manage, staff.manage, audit_log.view, and risky actions.",
    superAdminDefaultPermissionKeys(),
  );
  await upsertSystemRole(
    db,
    OWNER_ROLE_KEY,
    "Owner",
    "All business permissions; not roles.manage, staff.manage, or audit_log.view by default.",
    ownerDefaultPermissionKeys(),
  );
}

async function seedInitialCostAssumptions(db: Database) {
  // onConflictDoNothing, not check-then-write (CLAUDE.md forbids SELECT-then-INSERT: it
  // race-conditions if the seed step is ever invoked twice concurrently).
  await db
    .insert(costAssumptions)
    .values({
      effectiveFrom: "2026-10-01",
      marketplaceFeeBps: 1800,
      adsBps: 1200,
      returnsReserveBps: 300,
      targetProfitBps: 2000,
      packagingCostAmount: 4000,
    })
    .onConflictDoNothing({ target: costAssumptions.effectiveFrom });
}

// name is citext + unique, so onConflictDoNothing is race-safe across repeated/concurrent seed
// runs the same way seedInitialCostAssumptions' effective_from conflict target is.
// Services only (migration 0008) — the 4 goods formerly seeded here (Kancing, Handtag, Plat
// metal brand, Zipper packaging) now flow through the dedicated accessories/accessory_movements
// mechanism instead, which tracks their own stock and moving-average cost; cost_components
// exists only for costs that aren't a physical, stockable item (sewing fees, ...). The migration
// itself deletes or deactivates the 4 pre-existing seeded rows depending on whether any
// historical production_batch_costs row already references them.
const DEFAULT_COST_COMPONENTS = ["Ongkos jahit"] as const;

async function seedCostComponentDefaults(db: Database) {
  for (const [index, name] of DEFAULT_COST_COMPONENTS.entries()) {
    await db
      .insert(costComponents)
      .values({ name, unit: "pcs", sortOrder: index })
      .onConflictDoNothing({ target: costComponents.name });
  }
}

// Same "migration ships it, seed.ts also keeps a truncate-and-reseed test db in sync" dual
// mechanism as seedHomepageSections: migration 0037 inserts DRESS/"Gamis" for dev/prod (the
// products.product_type_code default depends on it), and packages/db/test/e2e-db.ts's TRUNCATE
// relies on THIS function to restore it. Insert-only, no conflict target: an existing row may
// carry the owner's rename, and a different type that already took the name "Gamis" must not
// make the seed fail.
async function seedDefaultProductType(db: Database) {
  await db.insert(productTypes).values({ code: DEFAULT_PRODUCT_TYPE_CODE, name: "Gamis", sortOrder: 0 }).onConflictDoNothing();
}

// Same dual mechanism again: migration 0039 inserts the one sales_goal row for dev/prod (the
// Ringkasan target tracker reads it), and this restores it after e2e-db.ts's TRUNCATE. Values match
// migration 0039 exactly (keep the two in sync by hand). Insert-only: an existing row may hold the
// owner's own target or start date.
async function seedSalesGoal(db: Database) {
  await db.insert(salesGoal).values({ id: 1, revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" }).onConflictDoNothing({ target: salesGoal.id });
}

async function seedStaffUserFromEnv(db: Database, emailVar: string, nameVar: string, roleKey: string) {
  const email = process.env[emailVar];
  const name = process.env[nameVar];
  if (!email || !name) {
    console.warn(`skipping staff user seed: ${emailVar} / ${nameVar} not set`);
    return;
  }

  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, roleKey)).limit(1);
  if (!role) throw new Error(`role "${roleKey}" was not seeded before staff users`);

  // onConflictDoNothing, not check-then-write (see seedInitialCostAssumptions). Note this is a
  // one-way "add," not a "rotate": if the env var's email changes between deploys, this inserts
  // a second staff_users row rather than renaming the existing account — the old email's row is
  // left untouched (and still holding its role). Rotating an email is a deliberate admin action,
  // not something this seed script should infer.
  await db.insert(staffUsers).values({ name, email, roleId: role.id }).onConflictDoNothing({ target: staffUsers.email });
}

async function seedStaffUsers(db: Database) {
  await seedStaffUserFromEnv(db, "SEED_SUPER_ADMIN_EMAIL", "SEED_SUPER_ADMIN_NAME", SUPER_ADMIN_ROLE_KEY);
  await seedStaffUserFromEnv(db, "SEED_OWNER_EMAIL", "SEED_OWNER_NAME", OWNER_ROLE_KEY);
}

export async function seed(db: Database = defaultDb) {
  await upsertChannels(db);
  await seedHomepageSections(db);
  await seedInfoPages(db);
  await seedStoreSettings(db);
  await syncPermissionCatalog(db);
  await seedSystemRoles(db);
  await seedInitialCostAssumptions(db);
  await seedCostComponentDefaults(db);
  await seedDefaultProductType(db);
  await seedSalesGoal(db);
  await seedStaffUsers(db);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  seed()
    .then(() => {
      console.log("seed complete");
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
