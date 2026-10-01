import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db as defaultDb } from "./client";
import { channels, costAssumptions, permissions, rolePermissions, roles, staffUsers } from "./schema";
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

const CHANNEL_NAMES: Record<string, string> = {
  shopee: "Shopee",
  tiktok: "TikTok Shop",
  web: "Main site",
  reseller: "Reseller",
};

async function upsertChannels(db: Database) {
  for (const [id, name] of Object.entries(CHANNEL_NAMES)) {
    await db.insert(channels).values({ id, name }).onConflictDoUpdate({ target: channels.id, set: { name } });
  }
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
  await syncPermissionCatalog(db);
  await seedSystemRoles(db);
  await seedInitialCostAssumptions(db);
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
