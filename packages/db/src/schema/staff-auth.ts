import { bigint, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext } from "./columns";
import { staffUsers } from "./rbac";

// Better Auth's core tables for the STAFF instance (apps/admin only — never shared with the
// future customer instance, which will get its own customer_auth_* tables, own cookie prefix,
// own secret). These are owned/written by Better Auth's own lifecycle (via @ammari/auth), not by
// our application code directly, so — unlike our own tables — they intentionally do NOT use the
// shared `timestamps()`/`set_updated_at` trigger convention: Better Auth sets `updatedAt` itself
// on every write.
//
// `staffUserId` is the link back to the actual RBAC source of truth (`staff_users`): role, active
// status, and permissions never live here, only identity/session plumbing does. It is NOT NULL,
// UNIQUE, and ON DELETE RESTRICT at the database level even though the Better Auth additionalField
// is declared `required: false` — that flag only controls Better Auth's own client-input
// validation layer; our `databaseHooks.user.create.before` hook (in @ammari/auth) always supplies
// it before the row is ever written, after `validateUserInfo` has already confirmed an active
// staff_users match, so the column can and should be a hard NOT NULL at the database level.
export const staffAuthUsers = pgTable("staff_auth_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffUserId: uuid("staff_user_id")
    .notNull()
    .unique()
    .references(() => staffUsers.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  email: citext("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const staffAuthAccounts = pgTable("staff_auth_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => staffAuthUsers.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("staff_auth_accounts_provider_account_key").on(table.providerId, table.accountId),
]);

export const staffAuthSessions = pgTable("staff_auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => staffAuthUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// Also backs the email-OTP flow's hashed code storage (storeOTP: "hashed" in @ammari/auth) — the
// `value` column holds the hash, never the plaintext code.
export const staffAuthVerifications = pgTable("staff_auth_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("staff_auth_verifications_identifier_key").on(table.identifier),
]);

// Better Auth's own rate-limit storage (rateLimit.storage: "database" in @ammari/auth), keyed by
// `${ip}|${path}` — see BaseRateLimit in better-auth's core schema. Database-backed (not memory)
// so limits survive restarts/deploys, per CLAUDE.md.
export const staffAuthRateLimits = pgTable("staff_auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: bigint("count", { mode: "number" }).notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
