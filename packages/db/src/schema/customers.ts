import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkIn, citext, timestamps } from "./columns";
import { CUSTOMER_TYPES, THANK_YOU_CARD_STATUSES, VOUCHER_STATUSES } from "./constants";
import { staffUsers } from "./rbac";
import { orders } from "./orders";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: phone is optional at account creation (e.g. a Google sign-up with no voucher
    // claim yet). Plain UNIQUE already allows multiple NULLs in Postgres (same reasoning as
    // vouchers.usedOrderId below), so no partial index is needed to permit several phone-less
    // customers.
    phone: text("phone").unique(),
    // Nullable (migration 0011): a staff-created customer from manual order entry (/orders/new)
    // is created with only a name and optional phone — no email is ever asked at that point.
    // citext UNIQUE already tolerates multiple NULLs the same way phone above does, so several
    // email-less customers never collide.
    email: citext("email").unique(),
    name: text("name").notNull(),
    type: text("type").notNull().default("retail"),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true, mode: "date" }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    // Nullable (migration 0011): a staff-created customer (manual order entry) has given no PDP
    // consent — stamping this automatically at staff-entry time would misrepresent consent that
    // was never actually given by the buyer. Stays null until the buyer later self-serves (a
    // voucher claim or main-site signup, docs/SPEC.md §4.3/§10.3), which is the only place real
    // consent is captured.
    pdpConsentAt: timestamp("pdp_consent_at", { withTimezone: true, mode: "date" }),
    promoConsentAt: timestamp("promo_consent_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    check("customers_type_check", checkIn(table.type, CUSTOMER_TYPES)),
    // Normalized by the app before insert: +62 followed by 8-13 digits. Only enforced when
    // phone is present — it's optional at the account level (see column comment above).
    // Note the doubled backslash: this is a JS template literal, and `\+` is not a recognized
    // JS escape sequence, so a single backslash here would silently be dropped, leaving a
    // malformed `^+62...` regex in the generated SQL.
    check(
      "customers_phone_format_check",
      sql`${table.phone} is null or ${table.phone} ~ '^\\+62[0-9]{8,13}$'`,
    ),
  ],
);

export const thankYouCards = pgTable(
  "thank_you_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("active"),
    claimDeadline: timestamp("claim_deadline", { withTimezone: true, mode: "date" }).notNull(),
    printedByStaffUserId: uuid("printed_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    claimedByCustomerId: uuid("claimed_by_customer_id").references(() => customers.id, {
      onDelete: "restrict",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    index("thank_you_cards_order_id_idx").on(table.orderId),
    index("thank_you_cards_printed_by_staff_user_id_idx").on(table.printedByStaffUserId),
    index("thank_you_cards_claimed_by_customer_id_idx").on(table.claimedByCustomerId),
    index("thank_you_cards_status_idx").on(table.status),
    // At most one ACTIVE card per order; reprints void the old card and insert a new one, so
    // history (voided cards) is kept.
    uniqueIndex("thank_you_cards_active_order_id_key")
      .on(table.orderId)
      .where(sql`${table.status} = 'active'`),
    check("thank_you_cards_status_check", checkIn(table.status, THANK_YOU_CARD_STATUSES)),
    check(
      "thank_you_cards_claimed_consistency_check",
      sql`(${table.status} = 'claimed') = (${table.claimedByCustomerId} is not null and ${table.claimedAt} is not null)`,
    ),
  ],
);

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .unique()
      .references(() => thankYouCards.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    amount: bigint("amount", { mode: "number" }).notNull().default(20000),
    status: text("status").notNull().default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    // Plain UNIQUE already allows multiple NULLs (Postgres treats NULL as distinct from NULL),
    // so this alone satisfies "unique where not null" without needing a partial index.
    usedOrderId: uuid("used_order_id").unique().references(() => orders.id, {
      onDelete: "restrict",
    }),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    index("vouchers_customer_id_idx").on(table.customerId),
    index("vouchers_status_idx").on(table.status),
    check("vouchers_status_check", checkIn(table.status, VOUCHER_STATUSES)),
    check("vouchers_amount_check", sql`${table.amount} >= 0`),
    check("vouchers_expires_after_issued_check", sql`${table.expiresAt} > ${table.issuedAt}`),
    check(
      "vouchers_used_consistency_check",
      sql`(${table.status} = 'used') = (${table.usedOrderId} is not null and ${table.usedAt} is not null)`,
    ),
  ],
);
