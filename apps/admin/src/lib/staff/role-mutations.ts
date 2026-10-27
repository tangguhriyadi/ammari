import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { permissions, rolePermissions, roles, staffUsers } from "@ammari/db/schema";
import { STAFF_ACCESS_LOCK_KEY, SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { SUPER_ADMIN_ONLY_PERMISSION_KEYS, permissionLabel, sortPermissionKeys } from "./permission-labels";

// The role write path (docs/plans/roles-staff.md §4.4, §5, §11a). Same shape as mutations.ts:
// every write is ONE transaction that first takes the staff-access advisory lock, so a
// role_permissions change can never interleave with a staff mutation's subset check (which reads
// role permissions under the same lock), and two role edits never interleave with each other.
// Only a super_admin holding roles.manage may write (owner answer 1), re-read under the lock.
// The super_admin role itself is never written, and roles.manage / audit_log.view are never
// granted to any other role, so nobody can lose or widen access to this page through it.

const ENTITY_TYPE = "role";
export const ROLE_AUDIT_ACTIONS = {
  create: "role.create",
  update: "role.update",
  permissionsUpdate: "role.permissions_update",
} as const;

const SUPER_ADMIN_READ_ONLY = "Super Admin selalu punya semua izin dan tidak bisa diubah.";

async function lockStaffAccess(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${STAFF_ACCESS_LOCK_KEY}))`);
}

async function rolePermissionKeys(tx: Tx, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));
  return sortPermissionKeys(rows.map((row) => row.key));
}

/** The actor's live role and permissions under the lock: active, role super_admin, holding
 * roles.manage. Anything else is refused even if the action layer was bypassed. */
async function loadRoleActor(tx: Tx, actorStaffUserId: string): Promise<Set<string>> {
  const [actor] = await tx
    .select({ roleId: staffUsers.roleId, roleKey: roles.key })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .where(and(eq(staffUsers.id, actorStaffUserId), eq(staffUsers.isActive, true)));
  const keys = actor ? new Set(await rolePermissionKeys(tx, actor.roleId)) : new Set<string>();
  if (!actor || actor.roleKey !== SUPER_ADMIN_ROLE_KEY || !keys.has("roles.manage")) throw new ActionError("Akses ditolak.");
  return keys;
}

/** Resolves keys to permission ids, refusing unknown keys, super_admin-only keys, and anything the
 * actor doesn't hold (the subset rule, §5). */
async function grantablePermissionIds(tx: Tx, keys: readonly string[], actorKeys: Set<string>): Promise<Map<string, string>> {
  const forbidden = keys.filter((key) => SUPER_ADMIN_ONLY_PERMISSION_KEYS.includes(key));
  if (forbidden.length > 0) {
    throw new FieldError("permissionKeys", `${permissionLabel(forbidden[0]!).label}: izin ini hanya untuk Super Admin.`);
  }
  const notHeld = keys.find((key) => !actorKeys.has(key));
  if (notHeld) throw new FieldError("permissionKeys", "Anda tidak bisa memberi izin yang tidak Anda miliki.");
  if (keys.length === 0) return new Map();
  const rows = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions).where(inArray(permissions.key, [...keys]));
  if (rows.length !== new Set(keys).size) throw new FieldError("permissionKeys", "Ada izin yang tidak dikenal.");
  return new Map(rows.map((row) => [row.key, row.id]));
}

/** Role names are what people pick from in the invite form, so two roles may not share one
 * (case-insensitive). Decided under the staff-access lock that every role write holds, so the
 * check and the write below can't be split by a concurrent rename. */
async function assertNameFree(tx: Tx, name: string, exceptRoleId?: string): Promise<void> {
  const [taken] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(sql`lower(${roles.name}) = lower(${name})`, exceptRoleId ? ne(roles.id, exceptRoleId) : undefined))
    .limit(1);
  if (taken) throw new FieldError("name", "Nama peran ini sudah dipakai.");
}

async function lockRole(tx: Tx, roleId: string) {
  const [role] = await tx
    .select({ id: roles.id, key: roles.key, name: roles.name, description: roles.description })
    .from(roles)
    .where(eq(roles.id, roleId))
    .for("update");
  if (!role) throw new ActionError("Peran tidak ditemukan.");
  if (role.key === SUPER_ADMIN_ROLE_KEY) throw new ActionError(SUPER_ADMIN_READ_ONLY);
  return role;
}

export interface CreateRoleInput {
  name: string;
  description: string | null;
  permissionKeys: readonly string[];
  /** "Salin dari peran ini": recorded in the audit row only; the keys above are what's granted. */
  copiedFromRoleId?: string | null;
}

export async function createRole(input: CreateRoleInput, actorStaffUserId: string, db: Database = defaultDb): Promise<{ roleId: string }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actorKeys = await loadRoleActor(tx, actorStaffUserId);
    await assertNameFree(tx, input.name);
    const keys = sortPermissionKeys(input.permissionKeys);
    const ids = await grantablePermissionIds(tx, keys, actorKeys);

    let copiedFromRoleKey: string | undefined;
    if (input.copiedFromRoleId) {
      const [source] = await tx.select({ key: roles.key }).from(roles).where(eq(roles.id, input.copiedFromRoleId));
      if (!source) throw new FieldError("copiedFromRoleId", "Peran sumber tidak ditemukan.");
      copiedFromRoleKey = source.key;
    }

    // The key is internal (never shown, never matched by application code, which checks
    // permission keys only), so a random one avoids any collision with a future predefined key.
    const key = `custom_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const [created] = await tx
      .insert(roles)
      .values({ key, name: input.name, description: input.description, isSystem: false })
      .returning({ id: roles.id });
    if (!created) throw new Error("failed to create role");
    if (ids.size > 0) {
      await tx.insert(rolePermissions).values([...ids.values()].map((permissionId) => ({ roleId: created.id, permissionId })));
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: ROLE_AUDIT_ACTIONS.create,
      entityType: ENTITY_TYPE,
      entityId: created.id,
      after: { key, name: input.name, permissionKeys: keys, ...(copiedFromRoleKey ? { copiedFromRoleKey } : {}) },
    });
    return { roleId: created.id };
  });
}

export interface UpdateRoleDetailsInput {
  name: string;
  description: string | null;
}

type LockedRole = Awaited<ReturnType<typeof lockRole>>;

async function applyRoleDetails(tx: Tx, role: LockedRole, input: UpdateRoleDetailsInput, actorStaffUserId: string): Promise<boolean> {
  const before: { name?: string; description?: string | null } = {};
  const after: { name?: string; description?: string | null } = {};
  if (input.name !== role.name) {
    await assertNameFree(tx, input.name, role.id);
    before.name = role.name;
    after.name = input.name;
  }
  if (input.description !== role.description) {
    before.description = role.description;
    after.description = input.description;
  }
  if (Object.keys(after).length === 0) return false;

  await tx.update(roles).set(after).where(eq(roles.id, role.id));
  await writeAuditLog(tx, { actorStaffUserId, action: ROLE_AUDIT_ACTIONS.update, entityType: ENTITY_TYPE, entityId: role.id, before, after });
  return true;
}

export interface UpdateRolePermissionsInput {
  permissionKeys: readonly string[];
  /** What the editor showed; see applyRolePermissions. */
  expectedPermissionKeys: readonly string[];
}

/** Replaces a role's permission set. If the role changed since the editor loaded it (another tab,
 * another admin), the save is refused instead of silently overwriting a change the confirmation
 * summary never showed. Takes effect on every holder's next request (getStaffSession re-reads
 * permissions each time). */
async function applyRolePermissions(
  tx: Tx,
  role: LockedRole,
  input: UpdateRolePermissionsInput,
  actorKeys: Set<string>,
  actorStaffUserId: string,
): Promise<boolean> {
  const current = await rolePermissionKeys(tx, role.id);
  const expected = sortPermissionKeys(input.expectedPermissionKeys);
  if (current.join(",") !== expected.join(",")) {
    throw new ActionError("Izin peran ini baru saja diubah. Muat ulang halaman lalu coba lagi.");
  }
  const next = sortPermissionKeys(input.permissionKeys);
  if (current.join(",") === next.join(",")) return false;

  const added = next.filter((key) => !current.includes(key));
  const removed = current.filter((key) => !next.includes(key));
  // Only what is being ADDED must be grantable: a key already on the role (e.g. a legacy
  // grant) may stay or be removed without tripping the subset rule.
  const addedIds = await grantablePermissionIds(tx, added, actorKeys);

  if (addedIds.size > 0) {
    await tx
      .insert(rolePermissions)
      .values([...addedIds.values()].map((permissionId) => ({ roleId: role.id, permissionId })))
      .onConflictDoNothing();
  }
  if (removed.length > 0) {
    await tx
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, role.id),
          inArray(rolePermissions.permissionId, tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.key, removed))),
        ),
      );
  }

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: ROLE_AUDIT_ACTIONS.permissionsUpdate,
    entityType: ENTITY_TYPE,
    entityId: role.id,
    before: { permissionKeys: current },
    after: { permissionKeys: next },
  });
  return true;
}

/** The role editor's one save: name, description and permissions in ONE transaction, so a
 * refused permission change never leaves a half-saved rename behind. Roles are never deleted in
 * v1 (owner answer 7). The owner role (system) is editable here on purpose: only the super_admin
 * role is fixed, and a super_admin always remains to undo a change. */
export async function updateRole(
  roleId: string,
  input: UpdateRoleDetailsInput & UpdateRolePermissionsInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actorKeys = await loadRoleActor(tx, actorStaffUserId);
    const role = await lockRole(tx, roleId);
    const permissionsChanged = await applyRolePermissions(tx, role, input, actorKeys, actorStaffUserId);
    const detailsChanged = await applyRoleDetails(tx, role, input, actorStaffUserId);
    return { changed: detailsChanged || permissionsChanged };
  });
}

export async function updateRoleDetails(
  roleId: string,
  input: UpdateRoleDetailsInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    await loadRoleActor(tx, actorStaffUserId);
    const role = await lockRole(tx, roleId);
    return { changed: await applyRoleDetails(tx, role, input, actorStaffUserId) };
  });
}

export async function updateRolePermissions(
  roleId: string,
  input: UpdateRolePermissionsInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actorKeys = await loadRoleActor(tx, actorStaffUserId);
    const role = await lockRole(tx, roleId);
    return { changed: await applyRolePermissions(tx, role, input, actorKeys, actorStaffUserId) };
  });
}
