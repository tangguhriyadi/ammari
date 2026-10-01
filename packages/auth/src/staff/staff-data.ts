import { and, eq, sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import {
  authEmailThrottle,
  permissions,
  rolePermissions,
  roles,
  staffAuthUsers,
  staffUsers,
} from "@ammari/db/schema";
import type { PermissionKey } from "@ammari/db/rbac";

export type Database = typeof defaultDb;

export interface ActiveStaff {
  id: string;
  name: string;
  email: string;
  roleId: string;
}

/** citext match is case-insensitive at the Postgres column level, so `OWNER@x.com` and
 * `owner@x.com` resolve to the same row — consistent with `staff_users.email`'s existing
 * citext convention. Returns `null` for both "no such email" and "inactive" — callers must
 * never distinguish the two (see docs/SPEC.md §10, generic-error requirement). */
export async function loadActiveStaffForEmail(db: Database, email: string): Promise<ActiveStaff | null> {
  const [row] = await db
    .select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email, roleId: staffUsers.roleId })
    .from(staffUsers)
    .where(and(eq(staffUsers.email, email), eq(staffUsers.isActive, true)))
    .limit(1);
  return row ?? null;
}

export interface StaffSessionData {
  staffUser: ActiveStaff;
  role: { id: string; key: string; name: string };
  permissionKeys: PermissionKey[];
}

/** The live, re-checked-on-every-call source of truth behind `getStaffSession()` — deliberately
 * never trusts a cached session payload. Returns `null` if the staff user is missing, inactive,
 * or (defensively) if their role record is gone — any of which must deny access, not throw. */
export async function loadStaffSessionData(db: Database, staffUserId: string): Promise<StaffSessionData | null> {
  const [row] = await db
    .select({
      staffUser: {
        id: staffUsers.id,
        name: staffUsers.name,
        email: staffUsers.email,
        roleId: staffUsers.roleId,
      },
      role: { id: roles.id, key: roles.key, name: roles.name },
    })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .where(and(eq(staffUsers.id, staffUserId), eq(staffUsers.isActive, true)))
    .limit(1);
  if (!row) return null;

  const permissionRows = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, row.role.id));

  return {
    staffUser: row.staffUser,
    role: row.role,
    permissionKeys: permissionRows.map((p) => p.key as PermissionKey),
  };
}

/** `databaseHooks.session.create.before`'s live gate: `session.userId` is a `staff_auth_users.id`
 * (Better Auth's own user model), not a `staff_users.id` — this resolves through the link and
 * re-checks `is_active` fresh on every session creation, independent of whatever
 * `validateUserInfo` decided earlier in the same request (it covers returning email-OTP sign-ins,
 * which `validateUserInfo` does not re-run for — see its doc comment). */
export async function isActiveStaffAuthUser(db: Database, staffAuthUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ isActive: staffUsers.isActive })
    .from(staffAuthUsers)
    .innerJoin(staffUsers, eq(staffAuthUsers.staffUserId, staffUsers.id))
    .where(eq(staffAuthUsers.id, staffAuthUserId))
    .limit(1);
  return row?.isActive ?? false;
}

/** `databaseHooks.session.create.after` — updates `staff_users.last_login_at` (docs/SPEC.md §10)
 * once a session has actually been created, i.e. login succeeded. */
export async function markStaffLastLogin(db: Database, staffAuthUserId: string): Promise<void> {
  const [row] = await db
    .select({ staffUserId: staffAuthUsers.staffUserId })
    .from(staffAuthUsers)
    .where(eq(staffAuthUsers.id, staffAuthUserId))
    .limit(1);
  if (!row) return;
  await db.update(staffUsers).set({ lastLoginAt: new Date() }).where(eq(staffUsers.id, row.staffUserId));
}

/** One row per OTP-send attempt (see schema/auth-throttle.ts for why this can't be derived from
 * Better Auth's own verification table) — records the attempt AND atomically returns how many
 * OTHER attempts already exist for `email` within `windowSeconds`, in a single SQL statement.
 *
 * The returned count does NOT include the row this call just inserted: a RETURNING subquery
 * over the same table runs against the command's own starting snapshot, which — per Postgres's
 * normal MVCC rule that a statement doesn't see its own effects — excludes the row the outer
 * INSERT is still in the middle of writing. Callers must treat the result as "prior attempts,"
 * i.e. block once this value reaches the limit, not once it exceeds it (confirmed by the
 * 6-requests-in-a-window test in packages/auth/test/staff-auth.test.ts).
 *
 * Deliberately not a separate "count, then decide, then insert" — per CLAUDE.md, anything that
 * can happen concurrently must not be check-then-write. Two concurrent requests for the same
 * email each run this as one atomic INSERT ... RETURNING; the only remaining imprecision is
 * truly-simultaneous requests not yet seeing each other's uncommitted insert under READ
 * COMMITTED, which can undercount by at most one per overlapping batch — an accepted, standard
 * tolerance for a rate limiter, unlike the previous unbounded-overcount race. */
export async function recordEmailThrottleAttemptAndCount(
  db: Database,
  email: string,
  windowSeconds: number,
): Promise<number> {
  const [row] = await db
    .insert(authEmailThrottle)
    .values({ email })
    .returning({
      count: sql<number>`(
        select count(*) from ${authEmailThrottle}
        where ${authEmailThrottle.email} = ${email}
          and ${authEmailThrottle.createdAt} > now() - make_interval(secs => ${windowSeconds})
      )`,
    });
  return Number(row?.count ?? 1);
}
