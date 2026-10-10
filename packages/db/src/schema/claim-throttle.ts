import { index, inet, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtOnly } from "./columns";

// IP-based throttle for the voucher claim endpoints themselves (apps/web's /claim/[token] view
// and the claim action) — NOT a Better Auth endpoint, so Better Auth's own per-IP rate limiter
// (customer_auth_rate_limits) doesn't cover it. Same "one row per attempt, atomic insert +
// windowed count" idiom as auth_email_throttle, keyed by (ip, action) instead of email.
//
// The query/cleanup helper that writes to this table is the claim flow's own work (not yet
// built — see docs/plans/voucher-claim.md, session 2). This migration only ships the table and
// its indexes, including the plain `created_at` index a cleanup delete needs (same reasoning as
// auth_email_throttle's own — see that file).
export const claimRateLimits = pgTable(
  "claim_rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ip: inet("ip").notNull(),
    action: text("action").notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("claim_rate_limits_ip_action_created_at_idx").on(table.ip, table.action, table.createdAt),
    index("claim_rate_limits_created_at_idx").on(table.createdAt),
  ],
);
