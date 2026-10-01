import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { checkIn, timestamps, createdAtOnly } from "./columns";
import {
  CHANNEL_IDS,
  EXPENSE_CATEGORIES,
  IMPORT_BATCH_KINDS,
  IMPORT_BATCH_STATUSES,
  ORDER_STATUSES,
} from "./constants";
import { productVariants } from "./catalog";
import { staffUsers } from "./rbac";
import { customers } from "./customers";

// `id` is a natural key (one of the 4 fixed values below) referenced by many FKs with the
// default ON UPDATE NO ACTION, so once any child row exists it is effectively immutable —
// intentional: channel ids are fixed, not user-editable data.
export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
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
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    channelOrderNo: text("channel_order_no").notNull(),
    status: text("status").notNull().default("to_ship"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    buyerUsername: text("buyer_username"),
    orderDate: timestamp("order_date", { withTimezone: true, mode: "date" }).notNull(),
    shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    returnedAt: timestamp("returned_at", { withTimezone: true, mode: "date" }),
    subtotalAmount: bigint("subtotal_amount", { mode: "number" }).notNull(),
    shippingAmount: bigint("shipping_amount", { mode: "number" }).notNull().default(0),
    discountAmount: bigint("discount_amount", { mode: "number" }).notNull().default(0),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, {
      onDelete: "restrict",
    }),
    ...timestamps(),
  },
  (table) => [
    unique("orders_channel_id_channel_order_no_key").on(table.channelId, table.channelOrderNo),
    index("orders_customer_id_idx").on(table.customerId),
    index("orders_import_batch_id_idx").on(table.importBatchId),
    index("orders_status_idx").on(table.status),
    index("orders_completed_at_idx").on(table.completedAt),
    check("orders_status_check", checkIn(table.status, ORDER_STATUSES)),
    check("orders_subtotal_amount_check", sql`${table.subtotalAmount} >= 0`),
    check("orders_shipping_amount_check", sql`${table.shippingAmount} >= 0`),
    check("orders_discount_amount_check", sql`${table.discountAmount} >= 0`),
    check("orders_total_amount_check", sql`${table.totalAmount} >= 0`),
    check(
      "orders_total_amount_balance_check",
      sql`${table.totalAmount} = ${table.subtotalAmount} + ${table.shippingAmount} - ${table.discountAmount}`,
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
    check("order_items_qty_check", sql`${table.qty} > 0`),
    check("order_items_unit_price_check", sql`${table.unitPrice} >= 0`),
    check("order_items_unit_cost_check", sql`${table.unitCost} >= 0`),
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
