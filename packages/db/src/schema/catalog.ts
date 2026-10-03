import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import {
  FABRIC_PRICE_UNITS,
  PRODUCT_CLOSURES,
  SIZE_MODES,
  SIZES,
  STOCK_MOVEMENT_REF_TYPES,
  STOCK_MOVEMENT_TYPES,
  type FabricPriceUnit,
  type ProductClosure,
  type Size,
  type SizeMode,
} from "./constants";
import { staffUsers } from "./rbac";

export const fabrics = pgTable(
  "fabrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    supplier: text("supplier"),
    composition: text("composition"),
    // Stores exactly what the user entered AND its unit — never a silently-converted per-meter
    // value. Pasar Baru shops often quote per yard; converting at entry time and discarding the
    // original unit would drift by rounding every time it's displayed back. Both null (price not
    // yet known) or both set — never one without the other.
    priceAmount: bigint("price_amount", { mode: "number" }),
    priceUnit: text("price_unit").$type<FabricPriceUnit>(),
    careInstructions: text("care_instructions"),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    check("fabrics_price_amount_check", sql`${table.priceAmount} >= 0`),
    check("fabrics_price_unit_check", checkIn(table.priceUnit, FABRIC_PRICE_UNITS)),
    check(
      "fabrics_price_amount_unit_pair_check",
      sql`(${table.priceAmount} is null) = (${table.priceUnit} is null)`,
    ),
  ],
);

// A fabric's named colors (e.g. "Sage", "Mocca") — belongs to the fabric, not to any one
// product: two products sharing a fabric share its color palette. `name` is citext so "Sage"
// and "sage" collide as the same color on one fabric (the unique constraint below).
export const fabricColors = pgTable(
  "fabric_colors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    // The supplier's own code/name for this color (e.g. "No. 23") — distinct from Ammari's own
    // color name above.
    supplierColorCode: text("supplier_color_code"),
    hex: text("hex"),
    // Never hard-deleted once referenced by a variant (ON DELETE RESTRICT below) — "delete" in
    // the UI means setting this false. A deactivated color can't be picked for a NEW variant
    // (application-level check) but stays visible on variants that already use it.
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    index("fabric_colors_fabric_id_idx").on(table.fabricId),
    unique("fabric_colors_fabric_id_name_key").on(table.fabricId, table.name),
    // Referenced by product_variants' composite FK below (fabric_color_id, fabric_id) ->
    // (id, fabric_id) — Postgres requires an explicit unique constraint over that exact column
    // pair, even though `id` alone is already unique.
    unique("fabric_colors_id_fabric_id_key").on(table.id, table.fabricId),
    check("fabric_colors_hex_check", sql`${table.hex} ~ '^#[0-9A-F]{6}$'`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Uppercase, alnum-only, derived from `name` at creation (see catalog/codes.ts) — feeds
    // SKU generation. Distinct from `slug` deliberately: `slug` stays editable after creation,
    // but a SKU prefix must never drift just because the product's URL slug was later edited.
    code: text("code").notNull().unique(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id, { onDelete: "restrict" }),
    closure: text("closure").$type<ProductClosure>().notNull(),
    // Chosen at creation, not editable once the product has any variant (enforced in
    // application code, not the DB — see enforce_variant_size_mode, migration 0004, for the
    // DB-level guarantee this pairs with: which SIZES a variant of this product may use).
    sizeMode: text("size_mode").$type<SizeMode>().notNull(),
    basePrice: bigint("base_price", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    // Exactly one image per product, chosen explicitly ("Jadikan thumbnail") from ANY of its
    // images. The composite FK that guarantees "must belong to this same product" —
    // (thumbnail_image_id, id) -> product_images(id, product_id) — is HAND-AUTHORED in
    // migration 0005, not declared here: product_images is defined further down this same file,
    // and drizzle-orm's `foreignKey()` helper evaluates `foreignColumns` eagerly (not via a
    // thunk), so a forward reference to a `const` declared later in the module would throw at
    // import time. Declared as plain `uuid` here for that reason; see migration 0005's
    // hand-authored section for the real constraint, same category as 0004's triggers.
    //
    // ON DELETE RESTRICT, not SET NULL: a composite FK's SET NULL would null out `id` too
    // (impossible — it's this table's own PK), and Postgres's column-scoped SET NULL (col)
    // syntax isn't expressible via Drizzle's schema DSL either. Instead,
    // lib/products/image-queries.ts's deleteProductImage computes the fallback thumbnail and
    // updates this column BEFORE deleting the image row, in the same transaction — which the
    // fallback rule (first general image, else first image of the first color, else null)
    // requires anyway, since it's app-level business logic, not something a DB trigger should
    // own. RESTRICT then becomes a free safety net against any future code path that forgets to
    // null this first.
    thumbnailImageId: uuid("thumbnail_image_id"),
    ...timestamps(),
  },
  (table) => [
    index("products_fabric_id_idx").on(table.fabricId),
    // products_thumbnail_image_id_fk's RESTRICT check runs this column against product_images
    // every time ANY image is deleted (including cascaded deletes when a product itself is
    // removed) — without this index that check seq-scans all of `products` (database-reviewer
    // finding, migration 0005; verified with EXPLAIN against a 20k-row table).
    index("products_thumbnail_image_id_idx").on(table.thumbnailImageId),
    check("products_closure_check", checkIn(table.closure, PRODUCT_CLOSURES)),
    check("products_size_mode_check", checkIn(table.sizeMode, SIZE_MODES)),
    check("products_base_price_check", sql`${table.basePrice} >= 0`),
    // Referenced by product_variants' composite FK below (product_id, fabric_id, closure) ->
    // (id, fabric_id, closure) — this is what makes "a product's fabric OR closure can't change
    // once it has variants" a real DB guarantee (ON UPDATE RESTRICT), not just an app-level
    // check: changing this row's fabric_id or closure while a variant still references the OLD
    // (id, fabric_id, closure) triple via that FK is rejected by Postgres itself. closure is
    // included because it's baked into every SKU (see codes.ts's CLOSURE_ABBREVIATIONS), exactly
    // like fabric_id is baked in via the color name.
    unique("products_id_fabric_id_closure_key").on(table.id, table.fabricId, table.closure),
    // Referenced by product_images' composite FK below (product_id, fabric_id) ->
    // (id, fabric_id) — same "denormalize + composite FK" technique as above, this time so an
    // image's color is guaranteed to belong to the SAME fabric as its own product (migration
    // 0005), mirroring product_variants_fabric_color_fabric_fk exactly.
    unique("products_id_fabric_id_key").on(table.id, table.fabricId),
  ],
);

// `sku` is a natural-key PK referenced by many FKs with the default ON UPDATE NO ACTION, so
// once any child row exists (a movement, order item, production line) it is effectively
// immutable — intentional: SKUs are assigned once and never renamed. The SKU is built from the
// color's NAME at the moment the variant is created (see catalog/codes.ts) and stays
// immutable even if fabric_colors.name is renamed afterward.
export const productVariants = pgTable(
  "product_variants",
  {
    sku: text("sku").primaryKey(),
    productId: uuid("product_id").notNull(),
    // Denormalized copy of products.fabric_id as of variant creation — required for the
    // composite FKs below (Postgres needs the actual column values present to enforce a
    // cross-table "same fabric" invariant; it cannot be derived through a join at constraint-
    // check time). Both composite FKs make this column's own single-column FK to products(id)
    // redundant, so it isn't declared separately.
    fabricId: uuid("fabric_id").notNull(),
    fabricColorId: uuid("fabric_color_id").notNull(),
    // Denormalized copy of products.closure as of variant creation, same reasoning as fabric_id
    // above — it's part of the product_variants_product_fabric_closure_fk composite FK, which is
    // what makes a product's closure immutable once it has variants (closure is baked into every
    // SKU, see codes.ts).
    closure: text("closure").$type<ProductClosure>().notNull(),
    size: text("size").$type<Size>().notNull(),
    priceOverrideAmount: bigint("price_override_amount", { mode: "number" }),
    minStockQty: integer("min_stock_qty").notNull().default(0),
    // Never hard-deleted once referenced (stock/orders/production all ON DELETE RESTRICT this
    // table) — "delete" in the UI always means setting this false instead.
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    index("product_variants_product_id_idx").on(table.productId),
    // listProducts' active-variant count and bulkSetMinStock's active-only update both filter on
    // this pair together — a composite index matches that query shape (packages/db reviewer
    // finding, migration 0005).
    index("product_variants_product_id_is_active_idx").on(table.productId, table.isActive),
    index("product_variants_fabric_color_id_idx").on(table.fabricColorId),
    unique("product_variants_product_color_size_key").on(table.productId, table.fabricColorId, table.size),
    check("product_variants_size_check", checkIn(table.size, SIZES)),
    check("product_variants_closure_check", checkIn(table.closure, PRODUCT_CLOSURES)),
    check("product_variants_price_override_amount_check", sql`${table.priceOverrideAmount} >= 0`),
    check("product_variants_min_stock_qty_check", sql`${table.minStockQty} >= 0`),
    // The two composite FKs together guarantee products.fabric_id === fabric_colors.fabric_id
    // for every variant (a variant's color always belongs to its own product's fabric), AND that
    // products.closure matches what's on the variant row (a product's closure can't change once
    // it has variants, same reasoning as fabric_id — see products_id_fabric_id_closure_key).
    foreignKey({
      columns: [table.productId, table.fabricId, table.closure],
      foreignColumns: [products.id, products.fabricId, products.closure],
      name: "product_variants_product_fabric_closure_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.fabricColorId, table.fabricId],
      foreignColumns: [fabricColors.id, fabricColors.fabricId],
      name: "product_variants_fabric_color_fabric_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No single-column FK here — superseded by the composite product_images_product_fabric_fk
    // below (same consolidation migration 0004 did for product_variants.product_id), which also
    // carries the ON DELETE CASCADE.
    productId: uuid("product_id").notNull(),
    // Denormalized copy of products.fabric_id as of image creation — exists ONLY so the two
    // composite FKs below can enforce, at the DB level, that this image's product and this
    // image's color always agree on the same fabric. Same technique as
    // product_variants.fabric_id (see that column's doc comment).
    fabricId: uuid("fabric_id").notNull(),
    storageKey: text("storage_key").notNull(),
    // Null = general image (applies to all colors of the product). No single-column FK —
    // superseded by product_images_fabric_color_fabric_fk below; MATCH SIMPLE (Postgres's
    // default) means that composite FK is simply not checked while this column is null, which is
    // exactly the "general image" case.
    fabricColorId: uuid("fabric_color_id"),
    altText: text("alt_text"),
    // Recorded from the image AFTER EXIF auto-rotation (see lib/products/image-processing.ts) —
    // so these numbers always match what's visually rendered, even for a 90°/270°-rotated photo
    // whose rotation swaps width and height.
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...createdAtOnly(),
  },
  (table) => [
    // No standalone product_id index — the composite index below has product_id as its leftmost
    // column, so it already serves any product_id-only query (leftmost-prefix rule); the old
    // single-column one (migration 0000) is dropped in migration 0005 as a strict subset with no
    // remaining read benefit, just extra write overhead (database-reviewer finding).
    index("product_images_fabric_color_id_idx").on(table.fabricColorId),
    // Matches the "Foto" section's own query shape: one group per (product, color), images
    // ordered within the group. Leftmost column (product_id) also covers any product_id-only
    // query — see note above.
    index("product_images_product_id_fabric_color_id_sort_order_idx").on(
      table.productId,
      table.fabricColorId,
      table.sortOrder,
    ),
    check("product_images_width_check", sql`${table.width} > 0`),
    check("product_images_height_check", sql`${table.height} > 0`),
    // Referenced by products.thumbnail_image_id's hand-authored composite FK (migration 0005) —
    // see that column's doc comment in the products table above for why it can't be declared
    // here via Drizzle's DSL.
    unique("product_images_id_product_id_key").on(table.id, table.productId),
    // The two composite FKs together guarantee products.fabric_id === fabric_colors.fabric_id
    // for every image, mirroring product_variants' own pair exactly (see that table's doc
    // comments): an image's color always belongs to its own product's fabric, and a product's
    // fabric can't change while it still has images referencing the OLD (id, fabric_id) pair.
    foreignKey({
      columns: [table.productId, table.fabricId],
      foreignColumns: [products.id, products.fabricId],
      name: "product_images_product_fabric_fk",
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.fabricColorId, table.fabricId],
      foreignColumns: [fabricColors.id, fabricColors.fabricId],
      name: "product_images_fabric_color_fabric_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
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
