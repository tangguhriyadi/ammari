import "server-only";
import { and, count, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { EmailSender } from "@ammari/auth";
import {
  auditLog,
  permissions,
  rolePermissions,
  roles,
  staffAuthSessions,
  staffAuthUsers,
  staffUsers,
} from "@ammari/db/schema";
import { OWNER_ROLE_KEY, STAFF_ACCESS_LOCK_KEY, SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { errorLogFields } from "@ammari/commerce/errors";
import { ActionError, FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { normalizeStaffEmail } from "./email";
import { buildStaffInviteEmail } from "./invite-email";

// The staff write path (docs/plans/roles-staff.md §5). Every mutation is ONE transaction that
// starts with the staff-access advisory lock, so all staff/role changes are serialized: the
// "last active super_admin/owner" count and the invite rate limits are never decided on a stale
// read (no check-then-write race, CLAUDE.md). Migration 0041's trigger takes the same lock and is
// the database backstop for the last super_admin. Permission checks happen twice on purpose: the
// action calls requirePermission("staff.manage"), and this module re-reads the actor's live
// permissions under the lock (a concurrent demotion of the actor can't slip through).

const INVITE_VALID_DAYS = 7;
const ACTOR_INVITES_PER_HOUR = 20;
const TARGET_INVITE_EMAIL_COOLDOWN_MINUTES = 10;
/** A hung provider must not hold the server action open forever after the commit. */
const INVITE_EMAIL_TIMEOUT_MS = 15_000;

const ENTITY_TYPE = "staff_user";
export const STAFF_AUDIT_ACTIONS = {
  invite: "staff.invite",
  inviteRenew: "staff.invite_renew",
  inviteEmailFailed: "staff.invite_email_failed",
  update: "staff.update",
  roleChange: "staff.role_change",
  deactivate: "staff.deactivate",
  reactivate: "staff.reactivate",
  sessionsRevoke: "staff.sessions_revoke",
} as const;
const INVITE_EMAIL_ACTIONS = [STAFF_AUDIT_ACTIONS.invite, STAFF_AUDIT_ACTIONS.inviteRenew];

/** Roles whose last active holder can't be removed (§5). super_admin is also enforced by the
 * migration 0041 trigger; losing the last owner is recoverable by a super_admin, so app-only. */
const PROTECTED_ROLE_MESSAGES: Record<string, string> = {
  [SUPER_ADMIN_ROLE_KEY]: "Super Admin aktif terakhir tidak bisa dinonaktifkan atau diganti perannya.",
  [OWNER_ROLE_KEY]: "Owner aktif terakhir tidak bisa dinonaktifkan atau diganti perannya.",
};

const STAFF_CONSTRAINT_FIELDS = {
  staff_users_email_unique: { field: "email", message: "Email ini sudah terdaftar." },
};

export interface StaffMutationDeps {
  db?: Database;
  /** Only invite/renew send email. Omitted means "don't send" (the row is the invitation). */
  emailSender?: EmailSender;
  /** The admin app's own origin, shown in the invite email. */
  loginUrl?: string;
}

interface LockedTarget {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
  inviteExpiresAt: Date | null;
}

async function lockStaffAccess(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${STAFF_ACCESS_LOCK_KEY}))`);
}

async function rolePermissionKeys(tx: Tx, roleId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));
  return new Set(rows.map((row) => row.key));
}

interface Actor {
  id: string;
  roleKey: string;
  keys: Set<string>;
}

/** The actor's live role and permissions, re-read under the lock. */
async function loadActor(tx: Tx, actorStaffUserId: string): Promise<Actor> {
  const [actor] = await tx
    .select({ roleId: staffUsers.roleId, roleKey: roles.key })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .where(and(eq(staffUsers.id, actorStaffUserId), eq(staffUsers.isActive, true)));
  const keys = actor ? await rolePermissionKeys(tx, actor.roleId) : new Set<string>();
  if (!actor || !keys.has("staff.manage")) throw new ActionError("Akses ditolak.");
  return { id: actorStaffUserId, roleKey: actor.roleKey, keys };
}

/** A hard rule on top of the subset rule (security review): only a super_admin may assign the
 * super_admin role or act on someone holding it, even if a future role edit gave another role
 * every permission. */
function assertSuperAdminOnly(roleKey: string, actor: Actor, message: string): void {
  if (roleKey === SUPER_ADMIN_ROLE_KEY && actor.roleKey !== SUPER_ADMIN_ROLE_KEY) throw new ActionError(message);
}

const ASSIGN_REFUSED = "Anda tidak bisa memberi peran dengan izin yang tidak Anda miliki.";
const MANAGE_REFUSED = "Anda tidak bisa mengubah staf yang punya izin yang tidak Anda miliki.";

function isSubset(inner: Set<string>, outer: Set<string>): boolean {
  for (const key of inner) if (!outer.has(key)) return false;
  return true;
}

/** No privilege escalation (§5): an actor may only assign a role, or act on a staff member whose
 * current role is, if every permission of that role is one the actor holds too. This is what
 * keeps the owner (staff.manage, no roles.manage/audit_log.view) away from every super_admin. */
async function assertRoleWithinActor(tx: Tx, roleId: string, actorKeys: Set<string>, message: string): Promise<void> {
  if (!isSubset(await rolePermissionKeys(tx, roleId), actorKeys)) throw new ActionError(message);
}

async function lockTarget(tx: Tx, staffUserId: string): Promise<LockedTarget> {
  const [row] = await tx
    .select({
      id: staffUsers.id,
      name: staffUsers.name,
      email: staffUsers.email,
      roleId: staffUsers.roleId,
      roleKey: roles.key,
      roleName: roles.name,
      isActive: staffUsers.isActive,
      lastLoginAt: staffUsers.lastLoginAt,
      invitedAt: staffUsers.invitedAt,
      inviteExpiresAt: staffUsers.inviteExpiresAt,
    })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .where(eq(staffUsers.id, staffUserId))
    .for("update", { of: staffUsers });
  if (!row) throw new ActionError("Staf tidak ditemukan.");
  return row;
}

/** Locks the target and applies the two rules every action on another person shares: never on
 * yourself, and only on someone whose role is within your own permissions. */
async function lockManageableTarget(tx: Tx, staffUserId: string, actor: Actor) {
  if (staffUserId === actor.id) throw new ActionError("Anda tidak bisa mengubah akun Anda sendiri di sini.");
  const target = await lockTarget(tx, staffUserId);
  assertSuperAdminOnly(target.roleKey, actor, MANAGE_REFUSED);
  await assertRoleWithinActor(tx, target.roleId, actor.keys, MANAGE_REFUSED);
  return target;
}

/** Both rules for a role being assigned (invite or role change). */
async function assertAssignable(tx: Tx, role: { id: string; key: string }, actor: Actor): Promise<void> {
  assertSuperAdminOnly(role.key, actor, ASSIGN_REFUSED);
  await assertRoleWithinActor(tx, role.id, actor.keys, ASSIGN_REFUSED);
}

/** Refuses to take the last active holder of super_admin/owner out of that role (deactivate or
 * role change). Correct only under lockStaffAccess, which every caller holds. Only holders who
 * can actually log in count: someone who has logged in, or a seed-style row with no invite
 * expiry. A pending invitation does not, since the person may never accept it (same rule as
 * migration 0041's trigger). */
async function assertNotLastProtectedHolder(tx: Tx, target: LockedTarget): Promise<void> {
  const message = PROTECTED_ROLE_MESSAGES[target.roleKey];
  if (!message || !target.isActive) return;
  const [others] = await tx
    .select({ count: count() })
    .from(staffUsers)
    .where(
      and(
        eq(staffUsers.roleId, target.roleId),
        eq(staffUsers.isActive, true),
        or(isNotNull(staffUsers.lastLoginAt), isNull(staffUsers.inviteExpiresAt)),
        ne(staffUsers.id, target.id),
      ),
    );
  if ((others?.count ?? 0) === 0) throw new ActionError(message);
}

async function assertActorInviteBudget(tx: Tx, actorStaffUserId: string): Promise<void> {
  const [recent] = await tx
    .select({ count: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorStaffUserId, actorStaffUserId),
        inArray(auditLog.action, INVITE_EMAIL_ACTIONS),
        gt(auditLog.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.count ?? 0) >= ACTOR_INVITES_PER_HOUR) throw new ActionError("Terlalu banyak undangan. Coba lagi nanti.");
}

async function assertTargetInviteCooldown(tx: Tx, staffUserId: string): Promise<void> {
  const [recent] = await tx
    .select({ count: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, ENTITY_TYPE),
        eq(auditLog.entityId, staffUserId),
        inArray(auditLog.action, INVITE_EMAIL_ACTIONS),
        gt(auditLog.createdAt, sql`now() - make_interval(mins => ${TARGET_INVITE_EMAIL_COOLDOWN_MINUTES})`),
      ),
    );
  if ((recent?.count ?? 0) > 0) {
    throw new ActionError(`Undangan baru saja dikirim. Coba lagi dalam ${TARGET_INVITE_EMAIL_COOLDOWN_MINUTES} menit.`);
  }
}

async function endSessions(tx: Tx, staffUserId: string): Promise<number> {
  const ended = await tx
    .delete(staffAuthSessions)
    .where(
      inArray(
        staffAuthSessions.userId,
        tx.select({ id: staffAuthUsers.id }).from(staffAuthUsers).where(eq(staffAuthUsers.staffUserId, staffUserId)),
      ),
    )
    .returning({ id: staffAuthSessions.id });
  return ended.length;
}

const inviteExpiresAtSql = sql`now() + make_interval(days => ${INVITE_VALID_DAYS})`;

interface InviteEmailTarget {
  id: string;
  name: string;
  email: string;
  roleName: string;
  inviteExpiresAt: Date;
}

/** Sent after the transaction commits, never inside it. A failure keeps the invitation (the row
 * is the invitation; the UI tells the owner to message the person) and is recorded in audit_log
 * with a short reason only, never the provider's response body. */
async function sendInviteEmail(target: InviteEmailTarget, actorStaffUserId: string, deps: StaffMutationDeps): Promise<boolean> {
  const { emailSender, loginUrl } = deps;
  if (!emailSender || !loginUrl) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const send = emailSender.send(
      buildStaffInviteEmail({
        to: target.email,
        name: target.name,
        roleName: target.roleName,
        loginUrl,
        inviteExpiresAt: target.inviteExpiresAt,
        idempotencyKey: `staff-invite:${target.id}:${target.inviteExpiresAt.toISOString()}`,
      }),
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("invite email send timed out")), INVITE_EMAIL_TIMEOUT_MS);
    });
    await Promise.race([send, timeout]);
    return true;
  } catch (error) {
    // errorLogFields: class name and code only. A provider error message can echo the address.
    console.error(`[staff] invite email failed for staff_user ${target.id}`, errorLogFields(error));
    // The invitation is already committed: nothing after this point may throw, or the owner
    // would see an error for an invite that exists (and "Email ini sudah terdaftar" on retry).
    try {
      await writeAuditLog(deps.db ?? defaultDb, {
        actorStaffUserId,
        action: STAFF_AUDIT_ACTIONS.inviteEmailFailed,
        entityType: ENTITY_TYPE,
        entityId: target.id,
        after: { reason: error instanceof Error ? error.name : "unknown" },
      });
    } catch (auditError) {
      console.error(`[staff] could not audit the failed invite email for staff_user ${target.id}`, errorLogFields(auditError));
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface InviteStaffInput {
  name: string;
  /** Already normalised by staffEmailSchema. */
  email: string;
  roleId: string;
}

export interface InviteResult {
  staffUserId: string;
  inviteExpiresAt: Date;
  emailSent: boolean;
}

export async function inviteStaff(input: InviteStaffInput, actorStaffUserId: string, deps: StaffMutationDeps = {}): Promise<InviteResult> {
  const db = deps.db ?? defaultDb;
  const invited = await db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    await assertActorInviteBudget(tx, actorStaffUserId);

    const [role] = await tx.select({ id: roles.id, key: roles.key, name: roles.name }).from(roles).where(eq(roles.id, input.roleId));
    if (!role) throw new FieldError("roleId", "Peran tidak ditemukan.");
    await assertAssignable(tx, role, actor);

    // ON CONFLICT on the unique email, not a "does it exist" SELECT first (CLAUDE.md).
    const [created] = await tx
      .insert(staffUsers)
      .values({
        name: input.name,
        email: input.email,
        roleId: role.id,
        invitedAt: sql`now()`,
        inviteExpiresAt: inviteExpiresAtSql,
        invitedByStaffUserId: actorStaffUserId,
      })
      .onConflictDoNothing({ target: staffUsers.email })
      .returning({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email, inviteExpiresAt: staffUsers.inviteExpiresAt });
    if (!created?.inviteExpiresAt) throw new FieldError("email", "Email ini sudah terdaftar.");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.invite,
      entityType: ENTITY_TYPE,
      entityId: created.id,
      after: { name: created.name, email: created.email, roleKey: role.key, inviteExpiresAt: created.inviteExpiresAt },
    });
    return { id: created.id, name: created.name, email: created.email, roleName: role.name, inviteExpiresAt: created.inviteExpiresAt };
  });

  const emailSent = await sendInviteEmail(invited, actorStaffUserId, deps);
  return { staffUserId: invited.id, inviteExpiresAt: invited.inviteExpiresAt, emailSent };
}

/** "Kirim ulang undangan": a fresh 7-day window from now, and the email again. Only for someone
 * who has never logged in; their account must be active. */
export async function renewStaffInvite(staffUserId: string, actorStaffUserId: string, deps: StaffMutationDeps = {}): Promise<InviteResult> {
  const db = deps.db ?? defaultDb;
  const renewed = await db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    const target = await lockManageableTarget(tx, staffUserId, actor);
    if (target.lastLoginAt) throw new ActionError("Staf ini sudah pernah masuk, tidak perlu undangan.");
    if (!target.isActive) throw new ActionError("Aktifkan kembali akun ini dulu.");
    await assertActorInviteBudget(tx, actorStaffUserId);
    await assertTargetInviteCooldown(tx, staffUserId);

    const [updated] = await tx
      .update(staffUsers)
      .set({ invitedAt: sql`coalesce(${staffUsers.invitedAt}, now())`, inviteExpiresAt: inviteExpiresAtSql })
      .where(eq(staffUsers.id, staffUserId))
      .returning({ inviteExpiresAt: staffUsers.inviteExpiresAt });
    if (!updated?.inviteExpiresAt) throw new Error("failed to renew staff invite");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.inviteRenew,
      entityType: ENTITY_TYPE,
      entityId: staffUserId,
      before: { inviteExpiresAt: target.inviteExpiresAt },
      after: { inviteExpiresAt: updated.inviteExpiresAt },
    });
    return { id: target.id, name: target.name, email: target.email, roleName: target.roleName, inviteExpiresAt: updated.inviteExpiresAt };
  });

  const emailSent = await sendInviteEmail(renewed, actorStaffUserId, deps);
  return { staffUserId: renewed.id, inviteExpiresAt: renewed.inviteExpiresAt, emailSent };
}

export interface UpdateStaffProfileInput {
  name: string;
  /** Already normalised. Only changeable before the first login (§4.3). */
  email: string;
}

export async function updateStaffProfile(
  staffUserId: string,
  input: UpdateStaffProfileInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    const target = await lockManageableTarget(tx, staffUserId, actor);

    const before: { name?: string; email?: string } = {};
    const after: { name?: string; email?: string } = {};
    if (input.name !== target.name) {
      before.name = target.name;
      after.name = input.name;
    }
    if (input.email !== normalizeStaffEmail(target.email)) {
      // After the first login the address is bound to staff_auth_users (and a Google account);
      // changing it here would orphan that link. Deactivate and invite the new address instead.
      const [linked] = await tx.select({ id: staffAuthUsers.id }).from(staffAuthUsers).where(eq(staffAuthUsers.staffUserId, staffUserId));
      if (target.lastLoginAt || linked) {
        throw new FieldError("email", "Email tidak bisa diubah setelah staf pernah masuk. Nonaktifkan akun ini lalu undang email baru.");
      }
      before.email = target.email;
      after.email = input.email;
    }
    if (Object.keys(after).length === 0) return { changed: false };

    try {
      await tx.update(staffUsers).set(after).where(eq(staffUsers.id, staffUserId));
    } catch (error) {
      mapUniqueViolation(error, STAFF_CONSTRAINT_FIELDS);
    }
    await writeAuditLog(tx, { actorStaffUserId, action: STAFF_AUDIT_ACTIONS.update, entityType: ENTITY_TYPE, entityId: staffUserId, before, after });
    return { changed: true };
  });
}

/** Takes effect on the person's next request: getStaffSession re-reads permissions every time,
 * so no session is ended (a packer is not logged out mid-shift). */
export async function changeStaffRole(
  staffUserId: string,
  roleId: string,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    const target = await lockManageableTarget(tx, staffUserId, actor);

    const [role] = await tx.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.id, roleId));
    if (!role) throw new FieldError("roleId", "Peran tidak ditemukan.");
    if (role.id === target.roleId) return { changed: false };
    await assertAssignable(tx, role, actor);
    await assertNotLastProtectedHolder(tx, target);

    await tx.update(staffUsers).set({ roleId: role.id }).where(eq(staffUsers.id, staffUserId));
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.roleChange,
      entityType: ENTITY_TYPE,
      entityId: staffUserId,
      before: { roleKey: target.roleKey },
      after: { roleKey: role.key },
    });
    return { changed: true };
  });
}

/** Immediately ends every session of the person (§5) in the same transaction; their open tab
 * also fails its next request through getStaffSession's live is_active check. The Google link
 * (staff_auth_accounts) is kept, so reactivation needs nothing new. Also how an unused invitation
 * is cancelled. */
export async function deactivateStaff(
  staffUserId: string,
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changed: boolean; sessionsEnded: number }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    const target = await lockManageableTarget(tx, staffUserId, actor);
    if (!target.isActive) return { changed: false, sessionsEnded: 0 };
    await assertNotLastProtectedHolder(tx, target);

    await tx.update(staffUsers).set({ isActive: false, deactivatedAt: sql`now()` }).where(eq(staffUsers.id, staffUserId));
    const sessionsEnded = await endSessions(tx, staffUserId);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.deactivate,
      entityType: ENTITY_TYPE,
      entityId: staffUserId,
      before: { isActive: true },
      after: { isActive: false, sessionsEnded },
    });
    return { changed: true, sessionsEnded };
  });
}

export async function reactivateStaff(staffUserId: string, actorStaffUserId: string, db: Database = defaultDb): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    const target = await lockManageableTarget(tx, staffUserId, actor);
    if (target.isActive) return { changed: false };

    await tx.update(staffUsers).set({ isActive: true, deactivatedAt: null }).where(eq(staffUsers.id, staffUserId));
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.reactivate,
      entityType: ENTITY_TYPE,
      entityId: staffUserId,
      before: { isActive: false },
      after: { isActive: true },
    });
    return { changed: true };
  });
}

/** "Akhiri semua sesi" (lost phone): logs the person out everywhere, account stays active. */
export async function revokeStaffSessions(staffUserId: string, actorStaffUserId: string, db: Database = defaultDb): Promise<{ sessionsEnded: number }> {
  return db.transaction(async (tx) => {
    await lockStaffAccess(tx);
    const actor = await loadActor(tx, actorStaffUserId);
    await lockManageableTarget(tx, staffUserId, actor);

    const sessionsEnded = await endSessions(tx, staffUserId);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: STAFF_AUDIT_ACTIONS.sessionsRevoke,
      entityType: ENTITY_TYPE,
      entityId: staffUserId,
      after: { sessionsEnded },
    });
    return { sessionsEnded };
  });
}
