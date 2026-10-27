import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import {
  permissions,
  rolePermissions,
  roles,
  staffAuthUsers,
  staffAuthVerifications,
  staffUsers,
} from "@ammari/db/schema";
import type { PermissionKey } from "@ammari/db/rbac";
import { getEmailCooldownRemainingSeconds } from "../shared/email-throttle";
import { OTP_RESEND_COOLDOWN_SECONDS } from "../shared/otp-timing";

export type Database = typeof defaultDb;

export interface ActiveStaff {
  id: string;
  name: string;
  email: string;
  roleId: string;
}

/** Who may log in at all: an active row whose invitation has not expired. The expiry only
 * applies until the first login (docs/plans/roles-staff.md §3): once `last_login_at` is set, or
 * when the row never had an expiry (rows from before migration 0041, seed accounts), it never
 * matters. Compared against Postgres `now()`, the same clock that set `invite_expires_at`. */
const isAdmissibleStaff = and(
  eq(staffUsers.isActive, true),
  or(isNotNull(staffUsers.lastLoginAt), isNull(staffUsers.inviteExpiresAt), gt(staffUsers.inviteExpiresAt, sql`now()`)),
);

/** citext match is case-insensitive at the Postgres column level, so `OWNER@x.com` and
 * `owner@x.com` resolve to the same row — consistent with `staff_users.email`'s existing
 * citext convention. Returns `null` for "no such email", "inactive" and "invitation expired"
 * alike — callers must never distinguish them (see docs/SPEC.md §10, generic-error
 * requirement). */
export async function loadActiveStaffForEmail(db: Database, email: string): Promise<ActiveStaff | null> {
  const [row] = await db
    .select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email, roleId: staffUsers.roleId })
    .from(staffUsers)
    .where(and(eq(staffUsers.email, email), isAdmissibleStaff))
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
    .select({ id: staffUsers.id })
    .from(staffAuthUsers)
    .innerJoin(staffUsers, eq(staffAuthUsers.staffUserId, staffUsers.id))
    .where(and(eq(staffAuthUsers.id, staffAuthUserId), isAdmissibleStaff))
    .limit(1);
  return Boolean(row);
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

// recordEmailThrottleAttempt lives in ../shared/email-throttle.ts — auth_email_throttle is
// shared with the customer Better Auth instance (see that table's own doc comment), so the
// function that writes to it is hoisted out of this staff-only module rather than duplicated.

export interface OtpResendState {
  /** Seconds until a fresh sign-in OTP send is allowed again for this email; 0 means nothing is
   * blocking a send right now. */
  cooldownRemainingSeconds: number;
  /** Only meaningful when `cooldownRemainingSeconds > 0` — see the customer instance's identical
   * `OtpResendState` (customer-data.ts) for the full "Case A vs Case B" reasoning; this is the
   * exact same mirror, just against `staff_auth_verifications` instead. */
  hasActiveCode: boolean;
}

/** Mirrors better-auth's own `toOTPIdentifier("sign-in", email)` — see the customer instance's
 * identical helper (customer-data.ts) for why this is duplicated rather than imported from
 * better-auth itself. */
function signInOtpIdentifier(email: string): string {
  return `sign-in-otp-${email}`;
}

/** Staff mirror of `getCustomerOtpResendState` (customer-data.ts) — same read-only "Case A vs
 * Case B" check, against `staff_auth_verifications` instead of `customer_auth_verifications`.
 * See that function's own doc comment for the full reasoning. */
export async function getStaffOtpResendState(db: Database, email: string): Promise<OtpResendState> {
  const normalizedEmail = email.trim().toLowerCase();
  const cooldownRemainingSeconds = await getEmailCooldownRemainingSeconds(db, normalizedEmail, OTP_RESEND_COOLDOWN_SECONDS);
  if (cooldownRemainingSeconds === 0) return { cooldownRemainingSeconds: 0, hasActiveCode: false };

  const [activeCode] = await db
    .select({ id: staffAuthVerifications.id })
    .from(staffAuthVerifications)
    .where(
      and(
        eq(staffAuthVerifications.identifier, signInOtpIdentifier(normalizedEmail)),
        gt(staffAuthVerifications.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return { cooldownRemainingSeconds, hasActiveCode: Boolean(activeCode) };
}
