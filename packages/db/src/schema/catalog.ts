import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { checkIn, createdAtOnly, timestamps } from "./columns";
import {
  PRODUCT_CLOSURES,
  SIZES,
  STOCK_MOVEMENT_REF_TYPES,
  STOCK_MOVEMENT_TYPES,
} from "./constants";
import { staffUsers } from "./rbac";

export const fabrics = pgTable(
  "fabrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    supplier: text("supplier"),
    composition: text("composition"),
    pricePerMeterAmount: bigint("price_per_meter_amount", { mode: "number" }),
    rollLengthCm: integer("roll_length_cm"),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    check("fabrics_price_per_meter_amount_check", sql`${table.pricePerMeterAmount} >= 0`),
    check("fabrics_roll_length_cm_check", sql`${table.rollLengthCm} >= 0`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id, { onDelete: "restrict" }),
    closure: text("closure").notNull(),
    basePrice: bigint("base_price", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    index("products_fabric_id_idx").on(table.fabricId),
    check("products_closure_check", checkIn(table.closure, PRODUCT_CLOSURES)),
    check("products_base_price_check", sql`${table.basePrice} >= 0`),
  ],
);

// `sku` is a natural-key PK referenced by many FKs with the default ON UPDATE NO ACTION, so
// once any child row exists (a movement, order item, production line) it is effectively
// immutable — intentional: SKUs are assigned once and never renamed.
export const productVariants = pgTable(
  "product_variants",
  {
    sku: text("sku").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    color: text("color").notNull(),
    size: text("size").notNull(),
    priceOverrideAmount: bigint("price_override_amount", { mode: "number" }),
    minStockQty: integer("min_stock_qty").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index("product_variants_product_id_idx").on(table.productId),
    unique("product_variants_product_color_size_key").on(table.productId, table.color, table.size),
    check("product_variants_size_check", checkIn(table.size, SIZES)),
    check("product_variants_price_override_amount_check", sql`${table.priceOverrideAmount} >= 0`),
    check("product_variants_min_stock_qty_check", sql`${table.minStockQty} >= 0`),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...createdAtOnly(),
  },
  (table) => [index("product_images_product_id_idx").on(table.productId)],
);

export const productionBatches = pgTable(
  "production_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id, { onDelete: "restrict" }),
    batchNo: text("batch_no").notNull().unique(),
    producedAt: date("produced_at", { mode: "string" }).notNull(),
    rollCount: integer("roll_count").notNull(),
    fabricCostAmount: bigint("fabric_cost_amount", { mode: "number" }).notNull().default(0),
    sewingCostAmount: bigint("sewing_cost_amount", { mode: "number" }).notNull().default(0),
    otherCostAmount: bigint("other_cost_amount", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    index("production_batches_fabric_id_idx").on(table.fabricId),
    check("production_batches_roll_count_check", sql`${table.rollCount} > 0`),
    check("production_batches_fabric_cost_amount_check", sql`${table.fabricCostAmount} >= 0`),
    check("production_batches_sewing_cost_amount_check", sql`${table.sewingCostAmount} >= 0`),
    check("production_batches_other_cost_amount_check", sql`${table.otherCostAmount} >= 0`),
  ],
);

export const productionBatchItems = pgTable(
  "production_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productionBatchId: uuid("production_batch_id")
      .notNull()
      .references(() => productionBatches.id, { onDelete: "cascade" }),
    sku: text("sku")
      .notNull()
      .references(() => productVariants.sku, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    // App-computed when the batch is saved: total batch cost / total batch qty, rounded up.
    unitCostAmount: bigint("unit_cost_amount", { mode: "number" }).notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("production_batch_items_production_batch_id_idx").on(table.productionBatchId),
    index("production_batch_items_sku_idx").on(table.sku),
    unique("production_batch_items_batch_sku_key").on(table.productionBatchId, table.sku),
    check("production_batch_items_qty_check", sql`${table.qty} > 0`),
    check("production_batch_items_unit_cost_amount_check", sql`${table.unitCostAmount} >= 0`),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku")
      .notNull()
      .references(() => productVariants.sku, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    type: text("type").notNull(),
    refType: text("ref_type").notNull(),
    refId: text("ref_id"),
    createdByStaffUserId: uuid("created_by_staff_user_id").references(() => staffUsers.id, {
      onDelete: "restrict",
    }),
    note: text("note"),
    ...createdAtOnly(),
  },
  (table) => [
    index("stock_movements_sku_idx").on(table.sku),
    index("stock_movements_ref_idx").on(table.refType, table.refId),
    index("stock_movements_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    // At most one ledger row per (type, source order_item/production_batch_item) — a retried
    // import or batch save must not double-count a stock movement for the same source row.
    // `type` is part of the key, not just ref_type/ref_id: a sale and a later return of the
    // same order_item legitimately share the same ref_id with different types, and must both
    // be allowed to post. Manual adjustments (ref_type = 'manual') have no single natural
    // source, so they're exempt.
    uniqueIndex("stock_movements_type_ref_unique_idx")
      .on(table.type, table.refType, table.refId)
      .where(sql`${table.refType} in ('order_item', 'production_batch_item')`),
    check("stock_movements_qty_check", sql`${table.qty} <> 0`),
    check("stock_movements_type_check", checkIn(table.type, STOCK_MOVEMENT_TYPES)),
    check("stock_movements_ref_type_check", checkIn(table.refType, STOCK_MOVEMENT_REF_TYPES)),
  ],
);
