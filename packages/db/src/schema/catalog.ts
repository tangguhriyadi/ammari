import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  bigint,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import {
  COST_COMPONENT_UNITS,
  FABRIC_PRICE_UNITS,
  PRODUCT_CLOSURES,
  PRODUCTION_BATCH_STATUSES,
  RAW_MATERIAL_MOVEMENT_REF_TYPES,
  RAW_MATERIAL_MOVEMENT_TYPES,
  SIZE_MODES,
  SIZES,
  STOCK_ADJUSTMENT_REASONS,
  STOCK_MOVEMENT_REF_TYPES,
  STOCK_MOVEMENT_TYPES,
  type CostComponentUnit,
  type FabricPriceUnit,
  type ProductClosure,
  type ProductionBatchStatus,
  type RawMaterialMovementRefType,
  type RawMaterialMovementType,
  type Size,
  type SizeMode,
  type StockAdjustmentReason,
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
    // `sku` alone is already the PK/unique, but Postgres requires a unique constraint covering
    // the EXACT column pair to be a composite-FK target — referenced by
    // production_batch_items_sku_fabric_fk below, same consolidation technique as
    // products_id_fabric_id_key for product_images.
    unique("product_variants_sku_fabric_id_key").on(table.sku, table.fabricId),
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
    // Replaces roll_count (migration 0007) — the owner buys by the yard from vendors whose roll
    // lengths vary, so a roll count was never a meaningful quantity. Nullable: required only at
    // POSTING time (postBatch enforces > 0 in app code), same "required later, not at draft-save
    // time" shape fabric_cost_amount's own posting check already has. The one pre-existing
    // posted batch (from before this column existed) keeps a NULL here permanently — see
    // getBatchDetail/the UI's "—" fallback, not a crash, for that row.
    fabricYards: numeric("fabric_yards", { precision: 10, scale: 2, mode: "number" }),
    fabricCostAmount: bigint("fabric_cost_amount", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    // draft -> posted, one-way (migration 0006). A draft is freely edited/deleted; once posted
    // it's read-only — enforced in app code (lockProductionBatchForUpdate's callers) backed by
    // posting's own transactional row lock, AND by three hand-authored triggers:
    // prevent_posted_batch_field_change (this table — migration 0007 froze fabric_yards/
    // fabric_cost_amount/fabric_id once posted; migration 0008 extended the SAME trigger to also
    // reject changing `status` itself away from 'posted'), prevent_posted_batch_items_mutation
    // (production_batch_items), prevent_posted_batch_cost_mutation (production_batch_costs
    // below) — both from migration 0007.
    status: text("status").$type<ProductionBatchStatus>().notNull().default("draft"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    postedByStaffUserId: uuid("posted_by_staff_user_id").references(() => staffUsers.id, {
      onDelete: "restrict",
    }),
    ...timestamps(),
  },
  (table) => [
    index("production_batches_fabric_id_idx").on(table.fabricId),
    index("production_batches_status_idx").on(table.status),
    // Nullable (draft) but never <= 0 once set — "required at posting" is an app-level check
    // (postBatch), same as fabric_cost_amount's own > 0-at-posting rule below.
    check("production_batches_fabric_yards_check", sql`${table.fabricYards} is null or ${table.fabricYards} > 0`),
    check("production_batches_fabric_cost_amount_check", sql`${table.fabricCostAmount} >= 0`),
    check("production_batches_status_check", checkIn(table.status, PRODUCTION_BATCH_STATUSES)),
    // Both-or-neither, same idiom as fabrics_price_amount_unit_pair_check — "posted" always
    // carries both posted_at and posted_by_staff_user_id, "draft" always carries neither.
    check(
      "production_batches_status_posted_pair_check",
      sql`(${table.status} = 'posted') = (${table.postedAt} is not null) and (${table.status} = 'posted') = (${table.postedByStaffUserId} is not null)`,
    ),
    // Referenced by production_batch_items' composite FK below (production_batch_id, fabric_id)
    // -> (id, fabric_id) — same "denormalize + composite FK" technique product_variants and
    // product_images already use, this time so a batch LINE's SKU is guaranteed to belong to the
    // SAME fabric as its own batch.
    unique("production_batches_id_fabric_id_key").on(table.id, table.fabricId),
  ],
);

// The owner's reusable master list of non-fabric cost types (accessories, sewing fees, ...) —
// migration 0007. `production_batch_costs` below snapshots a row's name/unit at the moment a
// line is added, so renaming a component here never rewrites history (same reasoning as
// product_variants.sku freezing a color's name at variant-creation time).
export const costComponents = pgTable(
  "cost_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: citext("name").notNull().unique(),
    unit: text("unit").$type<CostComponentUnit>().notNull(),
    defaultUnitPrice: bigint("default_unit_price", { mode: "number" }),
    // Never hard-deleted once referenced by any production_batch_costs row (ON DELETE RESTRICT
    // below) — "delete" in the UI always means setting this false, same as fabric_colors.
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    check("cost_components_unit_check", checkIn(table.unit, COST_COMPONENT_UNITS)),
    check("cost_components_default_unit_price_check", sql`${table.defaultUnitPrice} >= 0`),
  ],
);

export const productionBatchItems = pgTable(
  "production_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No single-column FK here — superseded by the composite
    // production_batch_items_batch_fabric_fk below, same consolidation technique migration 0004
    // used for product_variants.product_id.
    productionBatchId: uuid("production_batch_id").notNull(),
    // Denormalized copy of production_batches.fabric_id as of line creation — exists ONLY so the
    // two composite FKs below can enforce, at the DB level, that this line's batch and this
    // line's SKU always agree on the same fabric. Same technique as product_variants.fabricId/
    // product_images.fabricId (see those columns' doc comments).
    fabricId: uuid("fabric_id").notNull(),
    // No single-column FK here either — superseded by production_batch_items_sku_fabric_fk.
    sku: text("sku").notNull(),
    qty: integer("qty").notNull(),
    // App-computed ONLY at posting time: ceil(total batch cost / total batch qty) — see
    // postBatch. Zero while the batch is still a draft; not meaningful until status = 'posted'.
    unitCostAmount: bigint("unit_cost_amount", { mode: "number" }).notNull().default(0),
    ...createdAtOnly(),
  },
  (table) => [
    index("production_batch_items_production_batch_id_idx").on(table.productionBatchId),
    index("production_batch_items_sku_idx").on(table.sku),
    unique("production_batch_items_batch_sku_key").on(table.productionBatchId, table.sku),
    check("production_batch_items_qty_check", sql`${table.qty} > 0`),
    check("production_batch_items_unit_cost_amount_check", sql`${table.unitCostAmount} >= 0`),
    // Together these guarantee production_batches.fabric_id === product_variants.fabric_id for
    // every line (a line's SKU always belongs to its own batch's fabric) — mirrors
    // product_variants' own pair of composite FKs exactly (see that table's doc comments).
    foreignKey({
      columns: [table.productionBatchId, table.fabricId],
      foreignColumns: [productionBatches.id, productionBatches.fabricId],
      name: "production_batch_items_batch_fabric_fk",
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.sku, table.fabricId],
      foreignColumns: [productVariants.sku, productVariants.fabricId],
      name: "production_batch_items_sku_fabric_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
  ],
);

// Itemized non-fabric costs for one batch (accessories, sewing fees, ...) — migration 0007.
// `component_name`/`component_unit` are a SNAPSHOT of the referenced cost_components row at the
// moment this line was inserted, and are never rewritten by a later rename (see costComponents'
// doc comment) — only `quantity`/`unit_price` (and the generated `total`) are ever updated while
// the line still exists. `total` is a Postgres GENERATED column, not an app-computed value
// checked by a CHECK: computing it in JS (`Math.round(quantity * unitPrice)`) and verifying with
// a CHECK against Postgres's own `round()` would intermittently reject legitimate saves on float
// error (e.g. 0.35 * 10 is 3.4999999999999996 in IEEE 754 but exactly 3.5 in Postgres's numeric
// type, which rounds the opposite way) — a generated column means Postgres computes it once,
// the same way, every time; the app never writes it, only reads it back.
export const productionBatchCosts = pgTable(
  "production_batch_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productionBatchId: uuid("production_batch_id")
      .notNull()
      .references(() => productionBatches.id, { onDelete: "cascade" }),
    costComponentId: uuid("cost_component_id")
      .notNull()
      .references(() => costComponents.id, { onDelete: "restrict" }),
    componentName: text("component_name").notNull(),
    componentUnit: text("component_unit").$type<CostComponentUnit>().notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2, mode: "number" }).notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    total: bigint("total", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(sql`round(quantity * unit_price)`),
    ...createdAtOnly(),
  },
  (table) => [
    index("production_batch_costs_production_batch_id_idx").on(table.productionBatchId),
    // cost_component_id is NOT NULL + ON DELETE RESTRICT — indexed for the same reason every
    // other FK in this schema is: an unindexed RESTRICT check seq-scans this (append-only,
    // only-grows) table on every cost-component delete attempt.
    index("production_batch_costs_cost_component_id_idx").on(table.costComponentId),
    check("production_batch_costs_quantity_check", sql`${table.quantity} > 0`),
    check("production_batch_costs_unit_price_check", sql`${table.unitPrice} >= 0`),
    check("production_batch_costs_component_unit_check", checkIn(table.componentUnit, COST_COMPONENT_UNITS)),
  ],
);

// The "stock never goes negative" invariant (CLAUDE.md's atomicity rule) is enforced only by
// convention, not by a CHECK on this table — the running balance is a cross-row SUM, which
// Postgres can't express as a row-level constraint. Every writer that can DECREASE a SKU's
// balance MUST lock that SKU's product_variants row (`SELECT ... FOR UPDATE`, see
// lockVariantForUpdate / lockProductForUpdate) BEFORE computing the balance it checks against —
// see adjustStock/saveStockCount in apps/admin/src/lib/stock/queries.ts for the pattern. A
// purely-additive writer (e.g. postBatch in apps/admin/src/lib/production/queries.ts, which only
// ever inserts positive qty) is safe without this today, but any FUTURE writer that can insert a
// negative qty (a sale, a return-adjustment, anything from the Dec 2026 checkout work) MUST
// follow the same lock-first pattern — skipping it would silently reopen the negative-stock race
// this table's two existing writers were built specifically to close.
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
    // Only ever set for type = 'adjustment' (manual adjustment or stock count) — see the pair
    // check below. The allowed-values CHECK (checkIn) passes automatically while this is null,
    // same as fabrics.price_unit.
    reason: text("reason").$type<StockAdjustmentReason>(),
    ...createdAtOnly(),
  },
  (table) => [
    // (sku, created_at), not sku alone — covers any sku-only query via the leftmost-prefix rule
    // AND backs the SKU ledger's `WHERE sku = ? ORDER BY created_at` without a separate sort
    // (migration 0006, replacing the single-column stock_movements_sku_idx from migration 0000).
    index("stock_movements_sku_created_at_idx").on(table.sku, table.createdAt),
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
    check("stock_movements_reason_check", checkIn(table.reason, STOCK_ADJUSTMENT_REASONS)),
    // Only an 'adjustment' movement carries a reason — production/sale/return never do.
    check(
      "stock_movements_reason_adjustment_pair_check",
      sql`(${table.type} = 'adjustment') = (${table.reason} is not null)`,
    ),
  ],
);
// Append-only at the DB level (migration 0008, prevent_stock_movement_mutation trigger): no
// UPDATE or DELETE is ever allowed on this table, full stop — finished-goods movements are
// never corrected in place, only ever offset by inserting a new adjustment row. See
// accessory_movements below for the one ledger that DOES allow a single, narrow exception
// (voiding a purchase) to the same append-only rule.

// ---------- Raw-material inventory (accessories + fabric stock) — migration 0008 ----------

// The owner's master list of non-fabric physical items used in production (buttons, size
// labels, hang tags, metal brand plates, zipper packaging bags, ...). Stock/cost live entirely
// in accessory_movements below, never a column on this row — see that table's doc comment for
// why a plain SUM over the ledger is enough to derive both current stock AND a correct moving
// average cost, with no separate mutable counter to keep in sync.
export const accessories = pgTable(
  "accessories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Reuses the EXISTING Size/SIZES enum rather than a parallel one — "ALL/Polos" in the
    // product spec's own wording is exactly what ALLSIZE already means for a product_variant
    // (a single labelless item used regardless of size). Nullable: an accessory with no size
    // distinction at all (e.g. "Hang tag") simply never sets this.
    size: text("size").$type<Size>(),
    // citext, not text: groups the sized siblings of one logical accessory (e.g. "Label
    // Ammari" at XS/S/M/L/XL/ALLSIZE) for recipe resolution — case/typo variants of the same
    // group name must collide, not silently fork into two groups. The accessory form offers
    // existing group names as a selectable list for the same reason.
    sizeGroup: citext("size_group"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    check("accessories_size_check", checkIn(table.size, SIZES)),
    // NULLs never collide in a unique constraint, so two ungrouped (size_group IS NULL)
    // accessories are always allowed regardless of size — this only guards AGAINST two rows in
    // the SAME group claiming the same size, which would make size-group resolution ambiguous.
    unique("accessories_size_group_size_key").on(table.sizeGroup, table.size),
  ],
);

// The append-only ledger of every accessory stock change. Current stock = SUM(qty); current
// total value = SUM(value_amount); current average cost per pcs = the second divided by the
// first — NEVER stored, always derived, per the product spec's explicit requirement. This works
// without a separate mutable "running average" column because every row's OWN value_amount is
// computed ONCE, under the accessory's row lock, from the SUM-so-far, at the moment it's
// inserted:
//   - 'purchase': value_amount = the exact total amount paid (no rounding — it's literally what
//     was entered), qty = the quantity bought. This is the ONLY movement type that can move the
//     average (a consumption/adjustment is always valued AT whatever the average already is).
//   - 'production'/'adjustment' (a consumption, negative qty): value_amount =
//     -round(qty_consumed * current_average_cost_per_unit) — EXCEPT when this movement brings
//     SUM(qty) to exactly 0, in which case value_amount is instead set to exactly
//     -(current total value), not a separately-rounded qty*average — this is what keeps the
//     invariant "qty = 0 implies value = 0" and "qty > 0 implies value >= 0" EXACT despite
//     rounding (a plain round(qty*avg) can leave a few rupiah of residual value stranded at
//     zero stock, which would then corrupt the NEXT purchase's average). See
//     lib/inventory/moving-average.ts's valueDeltaForConsumption, and its dedicated test.
//   - 'purchase_void': an EXACT reversal of one earlier 'purchase' row — value_amount/qty are
//     literally the negation of that row's own values, never recomputed at the current average.
// A purchase can be voided only if no later movement exists for this accessory (checked by
// insertion order, under the row lock) — voiding "through" an intervening consumption would
// retroactively invalidate that consumption's already-recorded cost snapshot. The rejection
// message in that case tells the user to use a manual adjustment instead.
//
// DB-immutable (migration 0008, prevent_accessory_movement_mutation trigger): DELETE is always
// rejected; UPDATE is rejected UNLESS the only columns changing are voided_at/
// voided_by_staff_user_id, going from NULL, exactly once.
export const accessoryMovements = pgTable(
  "accessory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessoryId: uuid("accessory_id")
      .notNull()
      .references(() => accessories.id, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    valueAmount: bigint("value_amount", { mode: "number" }).notNull(),
    type: text("type").$type<RawMaterialMovementType>().notNull(),
    refType: text("ref_type").$type<RawMaterialMovementRefType>().notNull(),
    refId: text("ref_id"),
    // Only ever set for type = 'adjustment' — reuses STOCK_ADJUSTMENT_REASONS as-is (recount/
    // damaged/lost/other), same reasons finished-goods stock already uses.
    reason: text("reason").$type<StockAdjustmentReason>(),
    // Purchase-only, both optional on the form itself (supplier may be unknown; purchasedAt is
    // always required when type='purchase', checked below).
    supplier: text("supplier"),
    purchasedAt: date("purchased_at", { mode: "string" }),
    // Set only on a 'purchase_void' row, pointing back at the 'purchase' row it reverses.
    voidsMovementId: uuid("voids_movement_id").references((): AnyPgColumn => accessoryMovements.id, {
      onDelete: "restrict",
    }),
    // Set only on the ORIGINAL 'purchase' row, once, when it's later voided — doubles as the
    // double-void guard (checked under the accessory's row lock before inserting the void).
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedByStaffUserId: uuid("voided_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    createdByStaffUserId: uuid("created_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    // Free-text, same as stock_movements.note — meaningful on any movement type (a purchase's
    // own remark, or why an adjustment/void was made), not purchase-only like supplier/
    // purchasedAt above.
    note: text("note"),
    ...createdAtOnly(),
  },
  (table) => [
    index("accessory_movements_accessory_id_created_at_idx").on(table.accessoryId, table.createdAt),
    index("accessory_movements_ref_idx").on(table.refType, table.refId),
    // Both are NOT NULL-able RESTRICT FKs to staff_users on an append-only, only-grows table —
    // same reasoning stock_movements_created_by_staff_user_id_idx already gives for its own
    // sibling column (database-reviewer finding).
    index("accessory_movements_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    index("accessory_movements_voided_by_staff_user_id_idx").on(table.voidedByStaffUserId),
    unique("accessory_movements_voids_movement_id_key").on(table.voidsMovementId),
    check("accessory_movements_qty_check", sql`${table.qty} <> 0`),
    check("accessory_movements_type_check", checkIn(table.type, RAW_MATERIAL_MOVEMENT_TYPES)),
    check("accessory_movements_ref_type_check", checkIn(table.refType, RAW_MATERIAL_MOVEMENT_REF_TYPES)),
    check("accessory_movements_reason_check", checkIn(table.reason, STOCK_ADJUSTMENT_REASONS)),
    check(
      "accessory_movements_reason_adjustment_pair_check",
      sql`(${table.type} = 'adjustment') = (${table.reason} is not null)`,
    ),
    check(
      "accessory_movements_purchased_at_pair_check",
      sql`(${table.type} = 'purchase') = (${table.purchasedAt} is not null)`,
    ),
    check(
      "accessory_movements_voids_movement_id_pair_check",
      sql`(${table.type} = 'purchase_void') = (${table.voidsMovementId} is not null)`,
    ),
    check("accessory_movements_voided_at_type_check", sql`${table.voidedAt} is null or ${table.type} = 'purchase'`),
    check(
      "accessory_movements_voided_pair_check",
      sql`(${table.voidedAt} is not null) = (${table.voidedByStaffUserId} is not null)`,
    ),
  ],
);

// Identical shape to accessory_movements, fabric_id instead — see that table's doc comment for
// the full moving-average/void/immutability design, all of which applies here unchanged. `qty`
// is numeric(10,2) (yards), matching production_batches.fabric_yards' own precision/scale.
export const fabricStockMovements = pgTable(
  "fabric_stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id, { onDelete: "restrict" }),
    qty: numeric("qty", { precision: 10, scale: 2, mode: "number" }).notNull(),
    valueAmount: bigint("value_amount", { mode: "number" }).notNull(),
    type: text("type").$type<RawMaterialMovementType>().notNull(),
    refType: text("ref_type").$type<RawMaterialMovementRefType>().notNull(),
    refId: text("ref_id"),
    reason: text("reason").$type<StockAdjustmentReason>(),
    supplier: text("supplier"),
    purchasedAt: date("purchased_at", { mode: "string" }),
    voidsMovementId: uuid("voids_movement_id").references((): AnyPgColumn => fabricStockMovements.id, {
      onDelete: "restrict",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedByStaffUserId: uuid("voided_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    createdByStaffUserId: uuid("created_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    note: text("note"),
    ...createdAtOnly(),
  },
  (table) => [
    index("fabric_stock_movements_fabric_id_created_at_idx").on(table.fabricId, table.createdAt),
    index("fabric_stock_movements_ref_idx").on(table.refType, table.refId),
    index("fabric_stock_movements_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    index("fabric_stock_movements_voided_by_staff_user_id_idx").on(table.voidedByStaffUserId),
    unique("fabric_stock_movements_voids_movement_id_key").on(table.voidsMovementId),
    check("fabric_stock_movements_qty_check", sql`${table.qty} <> 0`),
    check("fabric_stock_movements_type_check", checkIn(table.type, RAW_MATERIAL_MOVEMENT_TYPES)),
    check("fabric_stock_movements_ref_type_check", checkIn(table.refType, RAW_MATERIAL_MOVEMENT_REF_TYPES)),
    check("fabric_stock_movements_reason_check", checkIn(table.reason, STOCK_ADJUSTMENT_REASONS)),
    check(
      "fabric_stock_movements_reason_adjustment_pair_check",
      sql`(${table.type} = 'adjustment') = (${table.reason} is not null)`,
    ),
    check(
      "fabric_stock_movements_purchased_at_pair_check",
      sql`(${table.type} = 'purchase') = (${table.purchasedAt} is not null)`,
    ),
    check(
      "fabric_stock_movements_voids_movement_id_pair_check",
      sql`(${table.type} = 'purchase_void') = (${table.voidsMovementId} is not null)`,
    ),
    check("fabric_stock_movements_voided_at_type_check", sql`${table.voidedAt} is null or ${table.type} = 'purchase'`),
    check(
      "fabric_stock_movements_voided_pair_check",
      sql`(${table.voidedAt} is not null) = (${table.voidedByStaffUserId} is not null)`,
    ),
  ],
);

// One product's bill of materials, excluding fabric (which is batch-level, not per-pcs — see
// production_batches.fabric_yards). Exactly one of accessoryId/sizeGroup is ever set: a row
// naming one specific, size-independent accessory (e.g. "Hang tag") resolves directly; a row
// naming a size GROUP resolves per variant at draft/posting time (sized variant -> the matching
// size's item; ALLSIZE variant -> the group's ALLSIZE/"Polos" item) — see the deferred
// production-integration step for that resolution logic. Saved as a full replace-the-set
// operation per product (same reasoning production_batch_items' delete-all-reinsert uses: these
// rows are current configuration, not a history that needs to survive unrelated edits), so no
// updatedAt is needed.
export const productAccessoryRecipes = pgTable(
  "product_accessory_recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    accessoryId: uuid("accessory_id").references(() => accessories.id, { onDelete: "restrict" }),
    sizeGroup: citext("size_group"),
    qtyPerPcs: integer("qty_per_pcs").notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("product_accessory_recipes_product_id_idx").on(table.productId),
    check(
      "product_accessory_recipes_exactly_one_target_check",
      sql`(${table.accessoryId} is null) <> (${table.sizeGroup} is null)`,
    ),
    check("product_accessory_recipes_qty_per_pcs_check", sql`${table.qtyPerPcs} > 0`),
    uniqueIndex("product_accessory_recipes_product_id_accessory_id_key")
      .on(table.productId, table.accessoryId)
      .where(sql`${table.accessoryId} is not null`),
    uniqueIndex("product_accessory_recipes_product_id_size_group_key")
      .on(table.productId, table.sizeGroup)
      .where(sql`${table.sizeGroup} is not null`),
  ],
);

// A per-batch override of the computed "needed quantity" for one RESOLVED accessory (e.g.
// waste/spares) — keyed by the resolved accessory, not by recipe row, since a mixed-product
// batch can have several recipe rows (across different products) resolve to the SAME accessory,
// and the override applies to their merged total. Populated/consumed only by the deferred
// production-integration step; the table is created now so this migration delivers the whole
// feature's schema in one piece.
export const productionBatchAccessoryOverrides = pgTable(
  "production_batch_accessory_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productionBatchId: uuid("production_batch_id")
      .notNull()
      .references(() => productionBatches.id, { onDelete: "cascade" }),
    accessoryId: uuid("accessory_id")
      .notNull()
      .references(() => accessories.id, { onDelete: "restrict" }),
    overrideQty: integer("override_qty").notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    unique("production_batch_accessory_overrides_batch_accessory_key").on(table.productionBatchId, table.accessoryId),
    check("production_batch_accessory_overrides_override_qty_check", sql`${table.overrideQty} >= 0`),
  ],
);
