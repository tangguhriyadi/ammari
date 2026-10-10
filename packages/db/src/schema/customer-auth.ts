import { bigint, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext } from "./columns";
import { customers } from "./customers";

// Better Auth's core tables for the CUSTOMER instance (apps/web only — never shared with the
// staff instance's own staff_auth_* tables, cookie prefix, or secret). Owned/written by Better
// Auth's own lifecycle (via @ammari/auth's createCustomerAuth), not by application code
// directly, so — like staff_auth_* — these intentionally do NOT use the shared
// timestamps()/set_updated_at trigger convention: Better Auth sets `updatedAt` itself.
//
// `customerId` is the link to the actual identity source of truth (`customers`): unlike
// staff_auth_users.staff_user_id, this is NULLABLE — a customer identity is created BY self
// sign-up (Google or email OTP), so there is no pre-existing `customers` row to require up
// front the way staff always has one. @ammari/auth's databaseHooks.user.create.before always
// supplies it (either linking to an existing `customers` row matched by verified email, or
// creating a fresh one) before the row is ever written — see create-customer-auth.ts.
export const customerAuthUsers = pgTable("customer_auth_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  email: citext("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const customerAuthAccounts = pgTable("customer_auth_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => customerAuthUsers.id, { onDelete: "cascade" }),
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
  uniqueIndex("customer_auth_accounts_provider_account_key").on(table.providerId, table.accountId),
]);

export const customerAuthSessions = pgTable("customer_auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => customerAuthUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// Also backs the email-OTP flow's hashed code storage (storeOTP: "hashed" in @ammari/auth) —
// the `value` column holds the hash, never the plaintext code. Same shape as
// staff_auth_verifications.
export const customerAuthVerifications = pgTable("customer_auth_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("customer_auth_verifications_identifier_key").on(table.identifier),
]);

// Better Auth's own rate-limit storage for this instance (rateLimit.storage: "database" in
// @ammari/auth), keyed by `${ip}|${path}` — same shape as staff_auth_rate_limits, database-
// backed so limits survive restarts/deploys, per CLAUDE.md.
export const customerAuthRateLimits = pgTable("customer_auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: bigint("count", { mode: "number" }).notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
