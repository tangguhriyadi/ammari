import { sql } from "drizzle-orm";
import { bigint, check, inet, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import { CUSTOMER_TYPES, OTP_PURPOSES, THANK_YOU_CARD_STATUSES, VOUCHER_STATUSES } from "./constants";
import { staffUsers } from "./rbac";
import { orders } from "./orders";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull().unique(),
    email: citext("email").notNull().unique(),
    name: text("name").notNull(),
    type: text("type").notNull().default("retail"),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true, mode: "date" }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    pdpConsentAt: timestamp("pdp_consent_at", { withTimezone: true, mode: "date" }).notNull(),
    promoConsentAt: timestamp("promo_consent_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    check("customers_type_check", checkIn(table.type, CUSTOMER_TYPES)),
    // Normalized by the app before insert: +62 followed by 8-13 digits.
    // Note the doubled backslash: this is a JS template literal, and `\+` is not a recognized
    // JS escape sequence, so a single backslash here would silently be dropped, leaving a
    // malformed `^+62...` regex in the generated SQL.
    check("customers_phone_format_check", sql`${table.phone} ~ '^\\+62[0-9]{8,13}$'`),
  ],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // citext, not text: CLAUDE.md requires OTP be rate-limited per destination, and an
    // attacker varying an email's case (Victim@Example.com vs victim@example.com) must not be
    // able to bypass that limit — matches the same citext choice on customers.email.
    destination: citext("destination").notNull(),
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    // Backs the CLAUDE.md-required "rate-limited ... per IP" half of OTP throttling (the
    // (destination, purpose, created_at) index below backs the per-destination half).
    requesterIp: inet("requester_ip"),
    ...createdAtOnly(),
  },
  (table) => [
    index("otp_codes_destination_purpose_created_at_idx").on(
      table.destination,
      table.purpose,
      table.createdAt,
    ),
    index("otp_codes_expires_at_idx").on(table.expiresAt),
    index("otp_codes_requester_ip_idx").on(table.requesterIp),
    check("otp_codes_purpose_check", checkIn(table.purpose, OTP_PURPOSES)),
    check("otp_codes_attempts_check", sql`${table.attempts} <= 5`),
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
