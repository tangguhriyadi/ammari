import { index, pgTable, uuid } from "drizzle-orm/pg-core";
import { citext, createdAtOnly } from "./columns";

// Records one row per OTP-send attempt, regardless of outcome (sent, unknown account, or
// throttled) — used to throttle OTP sends per destination email. Not specific to the staff
// instance: the future customer Better Auth instance (main site) reuses this same table.
//
// This exists because Better Auth's own emailOTP plugin deletes-and-recreates its single
// verification row per (type, email) identifier on every send (confirmed by reading
// node_modules/better-auth/dist/plugins/email-otp/routes.mjs's `resolveOTP`), so counting rows in
// the verification table itself would never see more than 1 regardless of how many times an
// email was requested — it cannot back a per-destination rate limit.
export const authEmailThrottle = pgTable(
  "auth_email_throttle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("auth_email_throttle_email_created_at_idx").on(table.email, table.createdAt),
    // Backs the opportunistic cleanup delete in @ammari/auth's shared/email-throttle.ts (a plain
    // age filter, not scoped to one email) — the composite index above has `email` as its
    // leading column, so it can't serve that query efficiently on its own.
    index("auth_email_throttle_created_at_idx").on(table.createdAt),
  ],
);
