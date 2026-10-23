import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { checkArraySubset, checkIn, citext, timestamps, createdAtOnly } from "./columns";
import {
  CHANNEL_IDS,
  EXPENSE_CATEGORIES,
  IMPORT_BATCH_KINDS,
  IMPORT_BATCH_STATUSES,
  ORDER_ATTENTION_FLAGS,
  ORDER_CANCEL_REASONS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  type ChannelId,
  type OrderAttentionFlag,
  type OrderCancelReason,
  type OrderPaymentStatus,
  type OrderStatus,
} from "./constants";
import { productVariants } from "./catalog";
import { staffUsers } from "./rbac";
import { customers } from "./customers";
import { shippingAreas } from "./checkout";

// `id` is a natural key (one of the 7 fixed values below) referenced by many FKs with the
// default ON UPDATE NO ACTION, so once any child row exists it is effectively immutable —
// intentional: channel ids are fixed, not user-editable data.
export const channels = pgTable(
  "channels",
  {
    id: text("id").$type<ChannelId>().primaryKey(),
    name: text("name").notNull(),
    ...timestamps(),
  },
  (table) => [check("channels_id_check", checkIn(table.id, CHANNEL_IDS))],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    status: text("status").notNull().default("pending"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    rowCount: integer("row_count"),
    errorMessage: text("error_message"),
    ...timestamps(),
  },
  (table) => [
    index("import_batches_channel_id_idx").on(table.channelId),
    index("import_batches_uploaded_by_idx").on(table.uploadedBy),
    index("import_batches_status_idx").on(table.status),
    check("import_batches_kind_check", checkIn(table.kind, IMPORT_BATCH_KINDS)),
    check("import_batches_status_check", checkIn(table.status, IMPORT_BATCH_STATUSES)),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id")
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    // Internal, always-present, human-readable number ("ORD-YYYYMM-NNNN", Jakarta month) —
    // generated for every order regardless of channel (see @ammari/commerce's
    // orders/order-number.ts, mirroring production's generateBatchNumber). This is what staff
    // and the UI reference everywhere.
    orderNo: text("order_no").notNull().unique(),
    // The MARKETPLACE's own order number — nullable because manual-entry channels (whatsapp/
    // instagram/offline/web/reseller) have no external order number at all. Postgres's plain
    // UNIQUE constraint already treats every NULL as distinct from every other NULL (same idiom
    // as customers.phone/vouchers.usedOrderId), so several manual orders on the same channel with
    // no channel_order_no never collide. REQUIRED (app-level, see lib/orders/queries.ts) for
    // MARKETPLACE_CHANNEL_IDS ("shopee"/"tiktok") specifically so a future importer's re-import
    // of the same order hits orders_channel_id_channel_order_no_key and updates in place instead
    // of inserting a duplicate.
    channelOrderNo: text("channel_order_no"),
    status: text("status").$type<OrderStatus>().notNull().default("to_ship"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    buyerUsername: text("buyer_username"),
    orderDate: timestamp("order_date", { withTimezone: true, mode: "date" }).notNull(),
    shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    returnedAt: timestamp("returned_at", { withTimezone: true, mode: "date" }),
    // Both optional, set (if at all) at the to_ship -> shipped transition (see
    // lib/orders/queries.ts's transitionOrderStatus) — packing can mark an order shipped with
    // no courier/tracking info at all, e.g. a bulk "Tandai dikirim". Free text, not an enum: the
    // admin UI offers a <datalist> of common Indonesian couriers as a typing aid, but never
    // restricts the value at the DB level (docs/plans/packing-cards.md).
    courier: text("courier"),
    trackingNumber: text("tracking_number"),
    subtotalAmount: bigint("subtotal_amount", { mode: "number" }).notNull(),
    shippingAmount: bigint("shipping_amount", { mode: "number" }).notNull().default(0),
    discountAmount: bigint("discount_amount", { mode: "number" }).notNull().default(0),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, {
      onDelete: "restrict",
    }),
    // Free-text shipping address for a manual order — a structured customer_addresses table is
    // deliberately deferred to the Dec 2026 main-site checkout work (docs/SPEC.md §5.2); this is
    // the pragmatic v1 shape for staff-entered orders. Lives on the order, not the customer, same
    // reasoning buyerUsername already does (an order's buyer identity doesn't require a resolved
    // customers row).
    shippingAddress: text("shipping_address"),
    notes: text("notes"),
    // Who recorded a manual order — null for an imported order (those are attributed via
    // import_batches.uploadedBy at the batch level instead).
    createdByStaffUserId: uuid("created_by_staff_user_id").references(() => staffUsers.id, {
      onDelete: "restrict",
    }),

    // ---- Storefront checkout (docs/plans/cart-checkout.md §3, migration 0030) ----
    // Every column below is nullable or defaulted, so the release before 0030 (whose INSERTs
    // name only the columns above) keeps working. A CHECKOUT order is one with
    // payment_status IS NOT NULL; staff-entered orders (any channel, `web` included) leave all
    // of these NULL / default.
    paymentStatus: text("payment_status").$type<OrderPaymentStatus>(),
    paymentExpiresAt: timestamp("payment_expires_at", { withTimezone: true, mode: "date" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    // Contact snapshot typed at checkout. Kept on the order (never copied onto a matched
    // customer, whose email is unverified at that point, plan §5 step 4). Anonymized by the
    // retention job (plan §11), so never required by a CHECK.
    contactEmail: citext("contact_email"),
    contactPhone: text("contact_phone"),
    recipientName: text("recipient_name"),
    // Structured address as typed; the text `shipping_address` above is filled too, so admin
    // order detail and packing keep working unchanged.
    shippingAddressSnapshot: jsonb("shipping_address_snapshot"),
    shippingAreaId: uuid("shipping_area_id").references((): AnyPgColumn => shippingAreas.id, {
      onDelete: "restrict",
    }),
    // Client-generated per checkout page load; UNIQUE makes a double submit return the same
    // order instead of creating a second one.
    checkoutAttemptId: uuid("checkout_attempt_id").unique("orders_checkout_attempt_id_key"),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true, mode: "date" }),
    promoOptIn: boolean("promo_opt_in"),
    cancelReason: text("cancel_reason").$type<OrderCancelReason>(),
    // A set of ORDER_ATTENTION_FLAGS (see its doc comment). Same three-constraint array shape
    // as products.highlights / suppliers.kinds.
    needsAttention: text("needs_attention").array().$type<OrderAttentionFlag[]>().notNull().default(sql`'{}'::text[]`),
    // Whether the buyer was logged in at checkout; decides whether emails carry the
    // "Masuk ke akun" link (plan §8).
    placedWithSession: boolean("placed_with_session"),

    // ---- Locked shipping quote (docs/plans/cart-checkout.md §4.5, migration 0031) ----
    // Written only by placeOrder, all eight together (orders_shipping_quote_all_or_none_check),
    // and never changed afterwards: a later tariff change or a different booking price is
    // Ammari's, never the buyer's. NULL on every non-checkout order. `shipping_amount` above is
    // the buyer's share, `shipping_cost_amount - shipping_subsidy_amount`.
    // The courier cost as quoted.
    shippingCostAmount: bigint("shipping_cost_amount", { mode: "number" }),
    // What Ammari covers on this order (at most the subsidy cap, a code constant in
    // @ammari/commerce/shipping, deliberately not a CHECK so the cap can change).
    shippingSubsidyAmount: bigint("shipping_subsidy_amount", { mode: "number" }),
    // As the shipping provider names them (Biteship `courier_code` / `courier_service_code`, which
    // are also its order `courier_company` / `courier_type`), e.g. `jne` / `reg`.
    shippingCourierCode: text("shipping_courier_code"),
    shippingServiceCode: text("shipping_service_code"),
    // Display label, e.g. "JNE Reguler".
    shippingCourierLabel: text("shipping_courier_label"),
    // Parcel weight sent for the quote: sum(qty x product weight) + the packaging allowance.
    shippingWeightGrams: integer("shipping_weight_grams"),
    // The provider area id (Biteship), snapshotted (a shipping_areas row can be re-synced).
    shippingDestinationId: text("shipping_destination_id"),
    shippingQuotedAt: timestamp("shipping_quoted_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    unique("orders_channel_id_channel_order_no_key").on(table.channelId, table.channelOrderNo),
    index("orders_customer_id_idx").on(table.customerId),
    index("orders_import_batch_id_idx").on(table.importBatchId),
    index("orders_status_idx").on(table.status),
    index("orders_completed_at_idx").on(table.completedAt),
    index("orders_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    check("orders_status_check", checkIn(table.status, ORDER_STATUSES)),
    check("orders_subtotal_amount_check", sql`${table.subtotalAmount} >= 0`),
    check("orders_shipping_amount_check", sql`${table.shippingAmount} >= 0`),
    check("orders_discount_amount_check", sql`${table.discountAmount} >= 0`),
    check("orders_total_amount_check", sql`${table.totalAmount} >= 0`),
    check(
      "orders_total_amount_balance_check",
      sql`${table.totalAmount} = ${table.subtotalAmount} + ${table.shippingAmount} - ${table.discountAmount}`,
    ),

    // ---- Storefront checkout (migration 0030) ----
    index("orders_shipping_area_id_idx").on(table.shippingAreaId),
    // The expiry sweeper's scan (plan §6.3): unpaid checkout orders past their hold.
    index("orders_checkout_awaiting_payment_idx")
      .on(table.paymentExpiresAt)
      .where(sql`${table.status} = 'awaiting_payment' and ${table.paymentStatus} is not null`),
    // "At most 3 unpaid web orders per contact email in 2 hours" (plan §5 step 1).
    index("orders_checkout_contact_email_idx")
      .on(table.contactEmail, table.createdAt)
      .where(sql`${table.paymentStatus} is not null`),
    // The admin "Perlu perhatian" filter.
    index("orders_needs_attention_idx")
      .on(table.createdAt)
      .where(sql`cardinality(${table.needsAttention}) > 0`),
    check(
      "orders_payment_status_check",
      sql`${table.paymentStatus} is null or ${checkIn(table.paymentStatus, ORDER_PAYMENT_STATUSES)}`,
    ),
    // Only the storefront checkout sets a payment status.
    check("orders_payment_status_web_only_check", sql`${table.channelId} = 'web' or ${table.paymentStatus} is null`),
    // What placeOrder always writes for a checkout order. Contact fields are left out on
    // purpose: the retention job anonymizes them (plan §11).
    check(
      "orders_checkout_fields_check",
      sql`${table.paymentStatus} is null or (${table.paymentExpiresAt} is not null and ${table.checkoutAttemptId} is not null and ${table.termsAcceptedAt} is not null and ${table.promoOptIn} is not null and ${table.placedWithSession} is not null)`,
    ),
    // Every state that can only follow a payment keeps its paid_at. NULL (non-checkout) passes.
    check(
      "orders_paid_at_check",
      sql`${table.paymentStatus} is null or ${table.paymentStatus} not in ('paid', 'refunded', 'partially_refunded', 'chargeback') or ${table.paidAt} is not null`,
    ),
    check(
      "orders_cancel_reason_check",
      sql`${table.cancelReason} is null or ${checkIn(table.cancelReason, ORDER_CANCEL_REASONS)}`,
    ),
    // `cancelled` is terminal (ORDER_STATUS_TRANSITIONS), so a reason can never outlive it.
    check("orders_cancel_reason_status_check", sql`${table.cancelReason} is null or ${table.status} = 'cancelled'`),
    check(
      "orders_contact_phone_format_check",
      sql`${table.contactPhone} is null or ${table.contactPhone} ~ '^\\+62[0-9]{8,13}$'`,
    ),
    check("orders_needs_attention_allowed_check", checkArraySubset(table.needsAttention, ORDER_ATTENTION_FLAGS)),
    check("orders_needs_attention_no_duplicates_check", sql`not text_array_has_duplicates(${table.needsAttention})`),

    // ---- Locked shipping quote (migration 0031) ----
    check(
      "orders_shipping_quote_all_or_none_check",
      sql`num_nulls(${table.shippingCostAmount}, ${table.shippingSubsidyAmount}, ${table.shippingCourierCode}, ${table.shippingServiceCode}, ${table.shippingCourierLabel}, ${table.shippingWeightGrams}, ${table.shippingDestinationId}, ${table.shippingQuotedAt}) in (0, 8)`,
    ),
    // The subsidy never exceeds the cost, and the buyer's share is exactly the rest, so the
    // existing total = subtotal + shipping - discount balance still holds. NULL (no quote) passes.
    check(
      "orders_shipping_quote_amounts_check",
      sql`${table.shippingCostAmount} is null or (${table.shippingSubsidyAmount} between 0 and ${table.shippingCostAmount} and ${table.shippingAmount} = ${table.shippingCostAmount} - ${table.shippingSubsidyAmount})`,
    ),
    check("orders_shipping_weight_grams_check", sql`${table.shippingWeightGrams} is null or ${table.shippingWeightGrams} > 0`),
    // Every checkout order carries a quote (no quote, no order; plan §4.5.5).
    check(
      "orders_checkout_shipping_quote_check",
      sql`${table.paymentStatus} is null or ${table.shippingCostAmount} is not null`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sku: text("sku")
      .notNull()
      .references(() => productVariants.sku, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    unitCost: bigint("unit_cost", { mode: "number" }).notNull(),
    // The undiscounted unit price at order time (docs/plans/product-discount.md §4, migration
    // 0036); `unit_price` stays what was actually charged. Written by placeOrder for every
    // checkout line (equal to unit_price when no discount was active). Manual orders write it only
    // when the line was charged below the SKU's normal price, else NULL. NULL on rows from before
    // 0036 and marketplace orders.
    listUnitPrice: bigint("list_unit_price", { mode: "number" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_sku_idx").on(table.sku),
    // Gives a retried/duplicate order import a conflict target at the line-item level, not
    // just the order header (orders_channel_id_channel_order_no_key) — without this, a
    // partially-failed import retry could double-insert line items for the same order+SKU,
    // silently doubling counted revenue/COGS and (via stock_movements) stock deductions.
    unique("order_items_order_id_sku_key").on(table.orderId, table.sku),
    // Target of stock_reservations' composite FK (migration 0030), so a reservation's order and
    // SKU always agree with the line it holds stock for.
    unique("order_items_id_order_id_sku_key").on(table.id, table.orderId, table.sku),
    check("order_items_qty_check", sql`${table.qty} > 0`),
    check("order_items_unit_price_check", sql`${table.unitPrice} >= 0`),
    check("order_items_unit_cost_check", sql`${table.unitCost} >= 0`),
    check("order_items_list_unit_price_check", sql`${table.listUnitPrice} is null or ${table.listUnitPrice} >= ${table.unitPrice}`),
  ],
);

export const orderSettlements = pgTable(
  "order_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    externalRef: text("external_ref").notNull(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, {
      onDelete: "restrict",
    }),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }).notNull(),
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    feeAmount: bigint("fee_amount", { mode: "number" }).notNull(),
    netAmount: bigint("net_amount", { mode: "number" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    index("order_settlements_order_id_idx").on(table.orderId),
    index("order_settlements_import_batch_id_idx").on(table.importBatchId),
    unique("order_settlements_order_id_external_ref_key").on(table.orderId, table.externalRef),
    // No >= 0 CHECKs here, unlike every other money column: marketplace income reports
    // contain negative adjustment rows (e.g. a refund clawback after a return), so gross/fee/
    // net can legitimately go negative. The balance relationship still must hold.
    check(
      "order_settlements_net_amount_balance_check",
      sql`${table.netAmount} = ${table.grossAmount} - ${table.feeAmount}`,
    ),
  ],
);

export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date", { mode: "string" }).notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    attributedRevenueAmount: bigint("attributed_revenue_amount", { mode: "number" })
      .notNull()
      .default(0),
    ...timestamps(),
  },
  (table) => [
    index("ad_spend_daily_channel_id_idx").on(table.channelId),
    unique("ad_spend_daily_date_channel_id_key").on(table.date, table.channelId),
    check("ad_spend_daily_amount_check", sql`${table.amount} >= 0`),
    check("ad_spend_daily_attributed_revenue_amount_check", sql`${table.attributedRevenueAmount} >= 0`),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    description: text("description"),
    createdByStaffUserId: uuid("created_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("expenses_date_idx").on(table.date),
    index("expenses_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    check("expenses_category_check", checkIn(table.category, EXPENSE_CATEGORIES)),
    check("expenses_amount_check", sql`${table.amount} >= 0`),
  ],
);

export const targets = pgTable(
  "targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    month: date("month", { mode: "string" }).notNull().unique(),
    revenueTargetAmount: bigint("revenue_target_amount", { mode: "number" }).notNull(),
    unitsTarget: integer("units_target").notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      "targets_month_first_of_month_check",
      sql`${table.month} = date_trunc('month', ${table.month}::date)::date`,
    ),
    check("targets_revenue_target_amount_check", sql`${table.revenueTargetAmount} >= 0`),
    check("targets_units_target_check", sql`${table.unitsTarget} >= 0`),
  ],
);

export const costAssumptions = pgTable(
  "cost_assumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull().unique(),
    marketplaceFeeBps: integer("marketplace_fee_bps").notNull(),
    adsBps: integer("ads_bps").notNull(),
    returnsReserveBps: integer("returns_reserve_bps").notNull(),
    targetProfitBps: integer("target_profit_bps").notNull(),
    packagingCostAmount: bigint("packaging_cost_amount", { mode: "number" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      "cost_assumptions_marketplace_fee_bps_check",
      sql`${table.marketplaceFeeBps} between 0 and 10000`,
    ),
    check("cost_assumptions_ads_bps_check", sql`${table.adsBps} between 0 and 10000`),
    check(
      "cost_assumptions_returns_reserve_bps_check",
      sql`${table.returnsReserveBps} between 0 and 10000`,
    ),
    check(
      "cost_assumptions_target_profit_bps_check",
      sql`${table.targetProfitBps} between 0 and 10000`,
    ),
    check("cost_assumptions_packaging_cost_amount_check", sql`${table.packagingCostAmount} >= 0`),
  ],
);
