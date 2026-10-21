import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import {
  ORDER_NOTIFICATION_KINDS,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  STOCK_RESERVATION_STATUSES,
  type OrderNotificationKind,
  type PaymentProvider,
  type PaymentStatus,
  type StockReservationStatus,
} from "./constants";
import { productVariants } from "./catalog";
import { customers } from "./customers";
import { orderItems, orders } from "./orders";

// Storefront cart, checkout and online payment (docs/plans/cart-checkout.md §3, migration 0030).
// Schema only: nothing reads or writes these tables until the later sessions of that plan.

/** Shipping-provider areas (province / city / kecamatan / kode pos), plan D12, D18, §4.5.1: Biteship
 * Maps areas since 2026-10-21 (Komerce before). No licence-clean dataset exists (session 3), so the
 * table is filled on demand: every area search (session 8) upserts what the provider returns,
 * keyed by `provider_area_id`. Checkout orders and saved addresses point here, and the browser only
 * ever sends this table's own `id`. Public reference data, no personal data (plan §11). */
export const shippingAreas = pgTable(
  "shipping_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    province: text("province").notNull(),
    city: text("city").notNull(),
    district: text("district").notNull(),
    // Kelurahan / desa (migration 0031). Nullable: Biteship areas are whole kecamatan (kecamatan +
    // kode pos), so it stays NULL with Biteship; kept for a provider that has the level.
    subdistrict: text("subdistrict"),
    // Nullable since migration 0031 (some Komerce destinations had none). Every Biteship area carries
    // one; a missing or malformed one is stored as NULL and the buyer types it (plan §4.5.1).
    postalCode: text("postal_code"),
    // Lowercased, accent-free label, kept for a later local-first search (v1 always asks the
    // provider, plan §4.5.1). No search index yet.
    searchText: text("search_text").notNull(),
    // Display label "Kecamatan, Kota, Provinsi 12345" (migration 0031). Nullable only because
    // columns added by a migration stay nullable (CLAUDE.md expand/contract); session 8's upsert
    // always writes it.
    label: text("label"),
    // The provider's area id (Biteship, e.g. `IDNP6IDNC148IDND843IDZ12250`). Named
    // `komerce_destination_id` until migration 0032 renamed it (plan D18). UNIQUE since migration
    // 0031 (several NULLs stay allowed, but every row written from session 8 on has one): the
    // upsert's ON CONFLICT target. Replaces the old (province, city, district, postal_code) UNIQUE.
    providerAreaId: text("provider_area_id").unique("shipping_areas_provider_area_id_key"),
    // When this row was last refreshed from a provider search (migration 0031).
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    // NULL (no kode pos) passes.
    check("shipping_areas_postal_code_format_check", sql`${table.postalCode} ~ '^[0-9]{5}$'`),
  ],
);

/** Shipping provider rate results (Biteship Rates since D18), reused for up to
 * SHIPPING_QUOTE_CACHE_MINUTES (plan §4.5.4) and pruned after 7 days (plan §11). `result` holds only the allowlisted services and their prices,
 * never a raw response. Written with INSERT ... ON CONFLICT DO UPDATE on the UNIQUE below. */
export const shippingRateCache = pgTable(
  "shipping_rate_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    originId: text("origin_id").notNull(),
    destinationId: text("destination_id").notNull(),
    weightGrams: integer("weight_grams").notNull(),
    // Hash of the courier service allowlist, so changing the allowlist never serves an old row.
    servicesKey: text("services_key").notNull(),
    result: jsonb("result").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("shipping_rate_cache_lookup_key").on(table.originId, table.destinationId, table.weightGrams, table.servicesKey),
    // The retention prune (plan §11).
    index("shipping_rate_cache_fetched_at_idx").on(table.fetchedAt),
    check("shipping_rate_cache_weight_grams_check", sql`${table.weightGrams} > 0`),
  ],
);

/** A database-backed cart (plan D2, §4.1). A guest cart is found by the sha256 of its httpOnly
 * cookie value (the raw value is never stored); a logged-in cart by customer. Both may be set
 * only transiently while a merge runs. */
export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").unique("carts_token_hash_key"),
    // CASCADE, unlike the usual RESTRICT: a cart is disposable state that should disappear with
    // its account (plan §11), never a reason to refuse an account deletion.
    customerId: uuid("customer_id")
      .unique("carts_customer_id_key")
      .references(() => customers.id, { onDelete: "cascade" }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    // Retention: guest carts 30 days, customer carts 180 days after last activity (plan §11).
    index("carts_last_activity_at_idx").on(table.lastActivityAt),
    check("carts_owner_check", sql`${table.tokenHash} is not null or ${table.customerId} is not null`),
  ],
);

/** Cart lines. No price column: the price is always re-read from products at render and at
 * checkout (plan §4.1). 1 to 10 per line; the 20-piece cart cap spans rows, so it is enforced by
 * the cart code (plan §4.1, decision 4). */
export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    sku: text("sku")
      .notNull()
      .references(() => productVariants.sku, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Also the cart_id index (leading column).
    unique("cart_items_cart_id_sku_key").on(table.cartId, table.sku),
    index("cart_items_sku_idx").on(table.sku),
    check("cart_items_qty_check", sql`${table.qty} between 1 and 10`),
  ],
);

/** Stock held for an unpaid checkout order line (plan D3). Storefront availability becomes
 * physical stock minus `active` rows with `expires_at > now()`; the `sale` movement is written
 * only at payment. Admin and marketplace paths keep checking physical stock only (D4). */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    orderItemId: uuid("order_item_id").notNull().unique("stock_reservations_order_item_id_key"),
    sku: text("sku").notNull(),
    qty: integer("qty").notNull(),
    status: text("status").$type<StockReservationStatus>().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    ...createdAtOnly(),
  },
  (table) => [
    // One composite FK instead of three single ones: the reservation's order and SKU must be
    // exactly its line's. RESTRICT, so deleting a line that still has a reservation (e.g. the
    // admin's delete-and-reinsert item edit on an awaiting_payment order) fails loudly instead
    // of silently dropping the hold. order_items.order_id / sku already reference orders and
    // product_variants.
    foreignKey({
      name: "stock_reservations_order_item_fk",
      columns: [table.orderItemId, table.orderId, table.sku],
      foreignColumns: [orderItems.id, orderItems.orderId, orderItems.sku],
    }).onDelete("restrict"),
    index("stock_reservations_order_id_idx").on(table.orderId),
    // Availability: SUM(qty) per SKU over active, unexpired rows (sku = ? and expires_at > now()).
    index("stock_reservations_active_sku_idx").on(table.sku, table.expiresAt).where(sql`${table.status} = 'active'`),
    // The sweeper's release scan.
    index("stock_reservations_active_expires_at_idx").on(table.expiresAt).where(sql`${table.status} = 'active'`),
    check("stock_reservations_status_check", checkIn(table.status, STOCK_RESERVATION_STATUSES)),
    check("stock_reservations_qty_check", sql`${table.qty} > 0`),
    check(
      "stock_reservations_consumed_consistency_check",
      sql`(${table.status} = 'consumed') = (${table.consumedAt} is not null)`,
    ),
    check(
      "stock_reservations_released_consistency_check",
      sql`(${table.status} = 'released') = (${table.releasedAt} is not null)`,
    ),
  ],
);

/** One row per payment attempt (plan D7). `provider_order_id` is what the gateway knows the
 * attempt by: `<env prefix><order_no>-<attempt>`. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    provider: text("provider").$type<PaymentProvider>().notNull(),
    providerOrderId: text("provider_order_id").notNull().unique("payments_provider_order_id_key"),
    // The gateway's transaction id, known only after the buyer picks a method.
    providerRef: text("provider_ref").unique("payments_provider_ref_key"),
    attempt: integer("attempt").notNull(),
    snapToken: text("snap_token"),
    redirectUrl: text("redirect_url"),
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    status: text("status").$type<PaymentStatus>().notNull().default("created"),
    paymentType: text("payment_type"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    refundedAmount: bigint("refunded_amount", { mode: "number" }).notNull().default(0),
    // An allowlisted subset of the last verified status response (never keys or signatures).
    lastStatus: jsonb("last_status"),
    ...timestamps(),
  },
  (table) => [
    // Also the order_id index (leading column).
    unique("payments_order_id_attempt_key").on(table.orderId, table.attempt),
    check("payments_provider_check", checkIn(table.provider, PAYMENT_PROVIDERS)),
    check("payments_status_check", checkIn(table.status, PAYMENT_STATUSES)),
    check("payments_attempt_check", sql`${table.attempt} >= 1`),
    check("payments_gross_amount_check", sql`${table.grossAmount} > 0`),
    check(
      "payments_refunded_amount_check",
      sql`${table.refundedAmount} >= 0 and ${table.refundedAmount} <= ${table.grossAmount}`,
    ),
    // Every state that can only follow a payment keeps its paid_at.
    check(
      "payments_paid_at_check",
      sql`${table.status} not in ('paid', 'refunded', 'partially_refunded', 'chargeback') or ${table.paidAt} is not null`,
    ),
  ],
);

/** Raw log of every payment notification received, valid or not (plan §6.1). No FK: a
 * notification can name an attempt this environment never created (shared Sandbox account) or
 * be malformed. Payloads are kept 12 months (plan §11). */
export const paymentNotifications = pgTable(
  "payment_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrderId: text("provider_order_id"),
    transactionStatus: text("transaction_status"),
    statusCode: text("status_code"),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    result: text("result"),
  },
  (table) => [
    index("payment_notifications_provider_order_id_idx").on(table.providerOrderId),
    index("payment_notifications_received_at_idx").on(table.receivedAt),
  ],
);

/** A customer's saved addresses (plan §4.3). Orders never point here: they store their own
 * snapshot (orders.shipping_address_snapshot). */
export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // CASCADE: kept "until the customer deletes them or the account is deleted" (plan §11).
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    recipientName: text("recipient_name").notNull(),
    phone: text("phone").notNull(),
    addressLine: text("address_line").notNull(),
    // Set for every address checkout saves (plan D12; saving addresses was deferred by the owner in
    // session 10 and is not built yet); a row without one shows
    // "Pilih ulang kecamatan" and cannot be used until re-picked (plan §4.5.1). The names below are
    // denormalized from the area and always filled.
    shippingAreaId: uuid("shipping_area_id").references(() => shippingAreas.id, { onDelete: "restrict" }),
    province: text("province").notNull(),
    city: text("city").notNull(),
    district: text("district").notNull(),
    // Kelurahan (migration 0031); NULL when the area is a whole kecamatan.
    subdistrict: text("subdistrict"),
    postalCode: text("postal_code").notNull(),
    notes: text("notes"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    index("customer_addresses_customer_id_idx").on(table.customerId),
    index("customer_addresses_shipping_area_id_idx").on(table.shippingAreaId),
    // At most one default address per customer.
    uniqueIndex("customer_addresses_default_customer_id_key")
      .on(table.customerId)
      .where(sql`${table.isDefault}`),
    check("customer_addresses_phone_format_check", sql`${table.phone} ~ '^\\+62[0-9]{8,13}$'`),
    check("customer_addresses_postal_code_format_check", sql`${table.postalCode} ~ '^[0-9]{5}$'`),
    check(
      "customer_addresses_coordinates_pair_check",
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    check(
      "customer_addresses_coordinates_range_check",
      sql`${table.latitude} is null or (${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180)`,
    ),
  ],
);

/** "Lihat pesanan" view-only links (plan §9.2): one row per email sent, only the sha256 of the
 * token stored, valid 120 days from issuance. */
export const orderAccessTokens = pgTable(
  "order_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique("order_access_tokens_token_hash_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("order_access_tokens_order_id_idx").on(table.orderId),
    // Retention: deleted 30 days after expiry (plan §11).
    index("order_access_tokens_expires_at_idx").on(table.expiresAt),
    check("order_access_tokens_expires_after_created_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/** Transactional email idempotency guard (plan D14, §8): the row is claimed before sending, so a
 * retried webhook never sends the same email twice. `error` records a failed send. */
export const orderNotifications = pgTable(
  "order_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    kind: text("kind").$type<OrderNotificationKind>().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    error: text("error"),
    ...timestamps(),
  },
  (table) => [
    // Also the order_id index (leading column).
    unique("order_notifications_order_id_kind_key").on(table.orderId, table.kind),
    check("order_notifications_kind_check", checkIn(table.kind, ORDER_NOTIFICATION_KINDS)),
  ],
);

/** "Masuk ke akun" one-time login links in guest order emails (plan §9.3, D15, migration 0033,
 * session 14). Issued server-side only by the order email step; only the sha256 of the token is
 * stored. A link logs in once (`consumed_at`), within 24 hours (`expires_at`), and only while it is
 * the customer's newest link: issuing a new one stamps `superseded_at` on the live one, and the
 * partial UNIQUE index keeps at most one live link per customer in the database itself. `email` is
 * the address it was sent to; consuming re-checks that the customer still has it. */
export const customerLoginLinks = pgTable(
  "customer_login_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    email: citext("email").notNull(),
    tokenHash: text("token_hash").notNull().unique("customer_login_links_token_hash_key"),
    /** The order whose email carried the link. */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
    consumedIp: inet("consumed_ip"),
    ...createdAtOnly(),
  },
  (table) => [
    uniqueIndex("customer_login_links_live_customer_id_key")
      .on(table.customerId)
      .where(sql`${table.consumedAt} is null and ${table.supersededAt} is null`),
    // The issuance cap counts a customer's links of the last 24 hours.
    index("customer_login_links_customer_id_created_at_idx").on(table.customerId, table.createdAt),
    index("customer_login_links_order_id_idx").on(table.orderId),
    // Retention: deleted 30 days after expiry (plan §11).
    index("customer_login_links_expires_at_idx").on(table.expiresAt),
    check("customer_login_links_token_hash_format_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("customer_login_links_expires_after_created_check", sql`${table.expiresAt} > ${table.createdAt}`),
    // A link ends one way: used, or replaced by a newer one.
    check("customer_login_links_single_end_check", sql`${table.consumedAt} is null or ${table.supersededAt} is null`),
    check("customer_login_links_consumed_ip_check", sql`${table.consumedIp} is null or ${table.consumedAt} is not null`),
  ],
);
