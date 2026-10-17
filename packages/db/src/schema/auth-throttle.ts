import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
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

// Records one row per /api/otp-resend-state request, regardless of outcome — a SEPARATE counter
// from auth_email_throttle above (that one is keyed by email and backs the per-email OTP-send
// cooldown; this one is keyed by IP and backs a per-IP cap on the read-only resend-state check
// endpoint, same CF-Connecting-IP approach and database-backed storage style as the existing
// per-IP OTP-send abuse guard — see @ammari/auth's createCustomerAuth/createStaffAuth
// OTP_IP_ABUSE_WINDOW_SECONDS/OTP_IP_ABUSE_MAX). Needed because that endpoint has no OTP of its
// own to send and so nothing else would ever throttle a caller hammering it to probe whether a
// given email recently requested a code. Not specific to either app — shared by both, same
// "one table, two Better Auth instances" convention as auth_email_throttle. `ip` is plain `text`,
// not `citext`: an IP address has no meaningful case-insensitive comparison.
export const authIpThrottle = pgTable(
  "auth_ip_throttle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ip: text("ip").notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("auth_ip_throttle_ip_created_at_idx").on(table.ip, table.createdAt),
    // Backs the opportunistic cleanup delete in @ammari/auth's shared/ip-throttle.ts — same
    // reasoning as auth_email_throttle_created_at_idx above.
    index("auth_ip_throttle_created_at_idx").on(table.createdAt),
  ],
);
