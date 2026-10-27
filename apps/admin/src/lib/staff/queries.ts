import "server-only";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditLog, permissions, rolePermissions, roles, staffAuthSessions, staffAuthUsers, staffUsers } from "@ammari/db/schema";
import { OWNER_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { defaultDb, type Database } from "@/lib/db";
import { canAssignRole, staffCapabilities, type CapabilityViewer, type StaffCapabilities } from "./capabilities";
import { sortPermissionKeys } from "./permission-labels";
import { staffStatus, type StaffStatus } from "./status";

// Read side of /roles-staff (docs/plans/roles-staff.md §4). Every page calls requirePermission
// first; these only shape data. Nothing here is a guard rail: the mutations re-check everything
// under the staff-access lock.

export interface StaffListRow {
  id: string;
  name: string;
  email: string;
  roleName: string;
  status: StaffStatus;
  lastLoginAt: Date | null;
  inviteExpiresAt: Date | null;
}

/** Every staff account, active first, then by name. A two-person business has a handful of
 * staff, so no paging. */
export async function listStaff(db: Database = defaultDb, now: Date = new Date()): Promise<StaffListRow[]> {
  const rows = await db
    .select({
      id: staffUsers.id,
      name: staffUsers.name,
      email: staffUsers.email,
      roleName: roles.name,
      isActive: staffUsers.isActive,
      lastLoginAt: staffUsers.lastLoginAt,
      inviteExpiresAt: staffUsers.inviteExpiresAt,
    })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .orderBy(desc(staffUsers.isActive), asc(sql`lower(${staffUsers.name})`), asc(staffUsers.email));
  return rows.map(({ isActive, ...row }) => ({ ...row, status: staffStatus({ isActive, ...row }, now) }));
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** Active accounts holding this role (pending invitations included). */
  activeStaffCount: number;
  permissionKeys: string[];
}

const ROLE_ORDER = sql`case ${roles.key} when ${SUPER_ADMIN_ROLE_KEY} then 0 when ${OWNER_ROLE_KEY} then 1 else 2 end`;

/** Every role with its permission keys (catalog order) and active staff count: super_admin,
 * owner, then the rest by name. */
export async function listRoles(db: Database = defaultDb): Promise<RoleRow[]> {
  const activeCounts = db
    .select({ roleId: staffUsers.roleId, count: count().as("active_count") })
    .from(staffUsers)
    .where(eq(staffUsers.isActive, true))
    .groupBy(staffUsers.roleId)
    .as("active_counts");
  const [roleRows, grantRows] = await Promise.all([
    db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
        activeStaffCount: sql<number>`coalesce(${activeCounts.count}, 0)`.mapWith(Number),
      })
      .from(roles)
      .leftJoin(activeCounts, eq(activeCounts.roleId, roles.id))
      .orderBy(ROLE_ORDER, asc(sql`lower(${roles.name})`)),
    db
      .select({ roleId: rolePermissions.roleId, key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id)),
  ]);
  const keysByRole = new Map<string, string[]>();
  for (const grant of grantRows) keysByRole.set(grant.roleId, [...(keysByRole.get(grant.roleId) ?? []), grant.key]);
  return roleRows.map((role) => ({ ...role, permissionKeys: sortPermissionKeys(keysByRole.get(role.id) ?? []) }));
}

export async function getRole(roleId: string, db: Database = defaultDb): Promise<RoleRow | null> {
  return (await listRoles(db)).find((role) => role.id === roleId) ?? null;
}

export interface AssignableRole {
  id: string;
  name: string;
  description: string | null;
  canViewProfit: boolean;
}

/** The roles the viewer may assign (invite or role change), same rule as the mutations. The owner
 * never sees super_admin here. */
export function assignableRoles(allRoles: readonly RoleRow[], viewer: CapabilityViewer): AssignableRole[] {
  return allRoles
    .filter((role) => canAssignRole(role, viewer))
    .map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      canViewProfit: role.permissionKeys.includes("finance.view_profit"),
    }));
}

export interface StaffHistoryRow {
  id: string;
  action: string;
  actorName: string | null;
  createdAt: Date;
}

export interface StaffDetail {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  status: StaffStatus;
  isActive: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
  inviteExpiresAt: Date | null;
  invitedByName: string | null;
  deactivatedAt: Date | null;
  activeSessionCount: number;
  capabilities: StaffCapabilities;
}

export async function getStaffDetail(
  staffUserId: string,
  viewer: CapabilityViewer,
  db: Database = defaultDb,
  now: Date = new Date(),
): Promise<StaffDetail | null> {
  const inviter = alias(staffUsers, "inviter");
  const [row] = await db
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
      deactivatedAt: staffUsers.deactivatedAt,
      invitedByName: inviter.name,
    })
    .from(staffUsers)
    .innerJoin(roles, eq(staffUsers.roleId, roles.id))
    .leftJoin(inviter, eq(staffUsers.invitedByStaffUserId, inviter.id))
    .where(eq(staffUsers.id, staffUserId));
  if (!row) return null;

  const [authUsers, sessions, grantRows, otherHolders] = await Promise.all([
    db.select({ id: staffAuthUsers.id }).from(staffAuthUsers).where(eq(staffAuthUsers.staffUserId, staffUserId)),
    db
      .select({ count: count() })
      .from(staffAuthSessions)
      .innerJoin(staffAuthUsers, eq(staffAuthSessions.userId, staffAuthUsers.id))
      .where(and(eq(staffAuthUsers.staffUserId, staffUserId), gt(staffAuthSessions.expiresAt, now))),
    db
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, row.roleId)),
    // Same "admissible holder" rule as mutations.ts's assertNotLastProtectedHolder.
    db
      .select({ count: count() })
      .from(staffUsers)
      .where(
        and(
          eq(staffUsers.roleId, row.roleId),
          eq(staffUsers.isActive, true),
          or(isNotNull(staffUsers.lastLoginAt), isNull(staffUsers.inviteExpiresAt)),
          ne(staffUsers.id, row.id),
        ),
      ),
  ]);
  const isProtectedRole = row.roleKey === SUPER_ADMIN_ROLE_KEY || row.roleKey === OWNER_ROLE_KEY;

  return {
    ...row,
    status: staffStatus(row, now),
    activeSessionCount: sessions[0]?.count ?? 0,
    capabilities: staffCapabilities(viewer, {
      id: row.id,
      roleKey: row.roleKey,
      rolePermissionKeys: grantRows.map((grant) => grant.key),
      isActive: row.isActive,
      lastLoginAt: row.lastLoginAt,
      hasAuthUser: authUsers.length > 0,
      isLastProtectedHolder: isProtectedRole && (otherHolders[0]?.count ?? 0) === 0,
    }),
  };
}

/** "Riwayat" on the staff page (shown only with audit_log.view): the last 20 audit rows about
 * this person. Only action, actor and time leave the server, never the before/after payloads. */
export async function listStaffHistory(staffUserId: string, db: Database = defaultDb): Promise<StaffHistoryRow[]> {
  return db
    .select({ id: auditLog.id, action: auditLog.action, actorName: staffUsers.name, createdAt: auditLog.createdAt })
    .from(auditLog)
    .leftJoin(staffUsers, eq(auditLog.actorStaffUserId, staffUsers.id))
    .where(and(eq(auditLog.entityType, "staff_user"), eq(auditLog.entityId, staffUserId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(20);
}
