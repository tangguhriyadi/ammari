import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAtOnly, citext, timestamps } from "./columns";

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  ...timestamps(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description").notNull(),
  group: text("group").notNull(),
  ...timestamps(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    ...createdAtOnly(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("role_permissions_permission_id_idx").on(table.permissionId),
  ],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: citext("email").notNull().unique(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    // Invitation fields (docs/plans/roles-staff.md §3, migration 0041). A staff_users row IS the
    // invitation: there is no separate invite table. `invite_expires_at` only matters until the
    // first login (`last_login_at IS NULL`); NULL means "no expiry" (every row that existed before
    // 0041, and seed-created accounts). The admission gate in @ammari/auth (staff-data.ts) refuses
    // a never-logged-in row whose invite has expired.
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "date" }),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true, mode: "date" }),
    invitedByStaffUserId: uuid("invited_by_staff_user_id").references((): AnyPgColumn => staffUsers.id, {
      onDelete: "restrict",
    }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    index("staff_users_role_id_idx").on(table.roleId),
    check("staff_users_invite_expiry_check", sql`${table.inviteExpiresAt} is null or ${table.invitedAt} is not null`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorStaffUserId: uuid("actor_staff_user_id").references(() => staffUsers.id, {
      onDelete: "restrict",
    }),
    // No CHECK constraint here: audit_log records open-ended, growing application events
    // (see docs/SPEC.md §9); constraining `action`/`entityType` would force a migration every
    // time a new admin action is added.
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    ...createdAtOnly(),
  },
  (table) => [
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_actor_staff_user_id_idx").on(table.actorStaffUserId),
    index("audit_log_created_at_idx").on(table.createdAt),
  ],
);
