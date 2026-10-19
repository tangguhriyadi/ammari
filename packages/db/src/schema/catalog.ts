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
import { checkArraySubset, checkIn, citext, createdAtOnly, timestamps } from "./columns";
import { sizeCharts } from "./content";
import {
  COST_COMPONENT_TYPES,
  COST_COMPONENT_UNITS,
  DEFECT_DISPOSAL_TYPES,
  DEFECT_ITEM_KINDS,
  DEFECT_MOVEMENT_TYPES,
  FABRIC_PRICE_UNITS,
  GOODS_RECEIPT_KINDS,
  GOODS_RECEIPT_SOURCE_TYPES,
  PURCHASE_ITEM_TYPES,
  PURCHASE_STATUSES,
  PRODUCT_CLOSURES,
  PRODUCT_HIGHLIGHT_KEYS,
  PRODUCTION_BATCH_STATUSES,
  PRODUCTION_RECEIPT_STATUSES,
  RAW_MATERIAL_MOVEMENT_REF_TYPES,
  RAW_MATERIAL_MOVEMENT_TYPES,
  SIZE_MODES,
  SIZES,
  STOCK_ADJUSTMENT_REASONS,
  STOCK_MOVEMENT_REF_TYPES,
  STOCK_MOVEMENT_TYPES,
  SUPPLIER_KINDS,
  type CostComponentType,
  type CostComponentUnit,
  type DefectDisposalType,
  type DefectItemKind,
  type DefectMovementType,
  type FabricPriceUnit,
  type GoodsReceiptKind,
  type GoodsReceiptSourceType,
  type PurchaseItemType,
  type PurchaseStatus,
  type ProductClosure,
  type ProductionBatchStatus,
  type ProductionReceiptStatus,
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
    // A FIXED set of selling-point keys (e.g. "breathable", "flowy"), NOT free text — the
    // future storefront maps each key to its own icon, which only works for a closed set (see
    // packages/db/src/schema/constants.ts's PRODUCT_HIGHLIGHT_KEYS, the single source of truth
    // for the set, and packages/db/src/catalog/highlights.ts for the Indonesian labels, which
    // are NOT stored here — only the key is). Display order is always
    // PRODUCT_HIGHLIGHT_KEYS' own canonical order, never this array's storage order — the admin
    // form writes it in that order already (checkboxes have no concept of reordering), and
    // every reader iterates the canonical list rather than trusting storage order, so this is
    // belt-and-suspenders, not a real dependency. Migration 0018.
    highlights: text("highlights").array().notNull().default(sql`'{}'::text[]`),
    // Storefront fields (docs/plans/storefront-cms.md, migration 0019) — additive/nullable or
    // defaulted, per CLAUDE.md's expand/contract rule.
    //
    // Distinct from `is_active` (sellable/produced) — flipping this IS the publish action for
    // this one product; there's no separate draft/publish pair for it the way the homepage has,
    // since there's no multi-field "half-finished" state to protect against (see the plan's
    // "Products: storefront fields" section). Guarded below by
    // products_is_published_on_storefront_active_check so an inactive product can never be
    // published.
    isPublishedOnStorefront: boolean("is_published_on_storefront").notNull().default(false),
    // The public "Deskripsi" accordion body — sanitized HTML (packages/content-sanitize, a later
    // session), deliberately separate from `description` above, which stays internal-only (the
    // admin's own working note). The storefront read layer (storefront/queries.ts) must NEVER
    // select `description` at all, not merely exclude it from rendering — see that module's own
    // doc comment and its dedicated cost-leak/description-distinctness test.
    storefrontDescription: text("storefront_description"),
    // Shown on the PDP instead of a size-chart table for `size_mode = 'all_size'` products
    // (nothing to tabulate for a single size) — plain text, not rich text. Null ⇒ the PDP shows
    // a generic "Ukuran: All Size" line.
    allsizeFitNote: text("allsize_fit_note"),
    // Only meaningful for `size_mode = 'sized'` products; null ⇒ the PDP's "Ukuran" accordion
    // omits the table. Not required at the DB level even for a `sized` product — a product can
    // exist mid-setup in admin before it has a chart assigned; "must have a chart before
    // publishing" is an app-level check at publish time, not a CHECK constraint here.
    sizeChartId: uuid("size_chart_id").references(() => sizeCharts.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("products_fabric_id_idx").on(table.fabricId),
    // products_thumbnail_image_id_fk's RESTRICT check runs this column against product_images
    // every time ANY image is deleted (including cascaded deletes when a product itself is
    // removed) — without this index that check seq-scans all of `products` (database-reviewer
    // finding, migration 0005; verified with EXPLAIN against a 20k-row table).
    index("products_thumbnail_image_id_idx").on(table.thumbnailImageId),
    // Same "index every RESTRICT-FK column" reasoning as thumbnail_image_id above — an unindexed
    // check seq-scans `products` on every size_charts delete attempt.
    index("products_size_chart_id_idx").on(table.sizeChartId),
    check("products_closure_check", checkIn(table.closure, PRODUCT_CLOSURES)),
    check("products_size_mode_check", checkIn(table.sizeMode, SIZE_MODES)),
    check("products_base_price_check", sql`${table.basePrice} >= 0`),
    check("products_highlights_allowed_check", checkArraySubset(table.highlights, PRODUCT_HIGHLIGHT_KEYS)),
    // Postgres flatly refuses a subquery inside ANY check constraint, even one that only reads
    // the row's own column (confirmed empirically against the real local Postgres 16 — "cannot
    // use subquery in check constraint" — not just assumed from the docs) — ARRAY(SELECT
    // DISTINCT unnest(...)) is exactly that, so "no duplicates" is expressed through a tiny
    // IMMUTABLE SQL function instead (hand-authored in this migration, same "hand-authored
    // addition to an auto-generated migration" idiom this codebase already uses for trigger
    // functions — see migration 0001's set_updated_at()). Confirmed working against the real
    // local Postgres too: a genuine duplicate is rejected with 23514.
    check("products_highlights_no_duplicates_check", sql`not text_array_has_duplicates(${table.highlights})`),
    // Technically implied once the two checks above both hold (5 distinct allowed keys, no
    // duplicates ⇒ at most 5 elements) — kept anyway as a cheap, explicit, self-documenting
    // invariant, same reasoning this schema already applies to plenty of other "belt and
    // suspenders" RESTRICT FKs/CHECKs.
    check("products_highlights_max_check", sql`cardinality(${table.highlights}) <= 5`),
    // Can't publish an inactive product — mirrors the existing belt-and-suspenders style
    // elsewhere in this schema. Does NOT prevent later deactivating an already-published
    // product (that's a legitimate admin action, just an unusual one); it only blocks setting
    // both columns into the disallowed combination in the same write.
    check(
      "products_is_published_on_storefront_active_check",
      sql`(not ${table.isPublishedOnStorefront}) or ${table.isActive}`,
    ),
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
    // Migration 0025 (docs/plans/suppliers-goods-receipt.md D5, session S4). Posting no longer
    // adds finished-goods stock; output enters stock only through goods receipts against this
    // batch (lib/receipts/production.ts). This column tracks that progress and is recomputed from
    // the receipts after every receipt/reversal; `closed` only by the short-close action. A NEW
    // column on purpose: `status` keeps its exact draft/posted domain, so the freeze trigger
    // (whose WHEN clause names its columns explicitly) and the previous release are untouched.
    // Batches posted before 0025 were backfilled to `received` (their stock was added at posting).
    receiptStatus: text("receipt_status").$type<ProductionReceiptStatus>().notNull().default("pending"),
    // Short-close ("Tutup batch", D19/D27): who closed it, when, and why. Same columns and the same
    // one-directional pair check as purchases'.
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    closedByStaffUserId: uuid("closed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    closeReason: text("close_reason"),
    // Re-open (D18, migration 0027): same three columns and rule as purchases'. New columns, so
    // the freeze trigger (whose WHEN clause names its columns) never sees them.
    reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: "date" }),
    reopenedByStaffUserId: uuid("reopened_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    reopenReason: text("reopen_reason"),
    ...timestamps(),
  },
  (table) => [
    index("production_batches_fabric_id_idx").on(table.fabricId),
    index("production_batches_status_idx").on(table.status),
    index("production_batches_receipt_status_idx").on(table.receiptStatus),
    // ON DELETE RESTRICT FK — indexed, this codebase's standing rule.
    index("production_batches_closed_by_staff_user_id_idx").on(table.closedByStaffUserId),
    index("production_batches_reopened_by_staff_user_id_idx").on(table.reopenedByStaffUserId),
    check(
      "production_batches_reopened_triple_check",
      sql`num_nonnulls(${table.reopenedAt}, ${table.reopenedByStaffUserId}, ${table.reopenReason}) in (0, 3) and (${table.reopenReason} is null or btrim(${table.reopenReason}) <> '')`,
    ),
    check("production_batches_receipt_status_check", checkIn(table.receiptStatus, PRODUCTION_RECEIPT_STATUSES)),
    // A draft has no output to receive yet.
    check("production_batches_draft_receipt_pending_check", sql`${table.status} <> 'draft' or ${table.receiptStatus} = 'pending'`),
    // One-directional (§3.4): `closed` always carries its close stamp; a batch re-opened later
    // (D18, S6) keeps the record of its last close.
    check(
      "production_batches_closed_status_check",
      sql`${table.receiptStatus} <> 'closed' or ${table.closedAt} is not null`,
    ),
    check(
      "production_batches_closed_pair_check",
      sql`(${table.closedAt} is not null) = (${table.closedByStaffUserId} is not null)`,
    ),
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
    // "variable" (scales with the batch's pcs count, e.g. "Ongkos jahit") or "fixed" (one flat
    // amount per batch regardless of pcs) — migration 0010. Snapshotted onto
    // production_batch_costs.cost_type at the moment a line is added, same reasoning as
    // componentName/componentUnit (a later change here never rewrites history). Controls how
    // that line's `quantity` is computed server-side — see postBatch/syncExtraCostLines.
    costType: text("cost_type").$type<CostComponentType>().notNull().default("variable"),
    // Never hard-deleted once referenced by any production_batch_costs row (ON DELETE RESTRICT
    // below) — "delete" in the UI always means setting this false, same as fabric_colors.
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    // Migration 0023 (docs/plans/suppliers-goods-receipt.md D9). Who is USUALLY paid for this
    // component (e.g. the tailor behind "Ongkos jahit") — only ever a PREFILL for a new
    // production_batch_costs line, never read at posting and never copied onto an existing line
    // when changed here. Nullable: most components have no single supplier. A supplier
    // deactivated after being set here keeps displaying (and keeps being saved unchanged), but
    // can't be newly chosen — see updateCostComponent.
    defaultSupplierId: uuid("default_supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    // ON DELETE RESTRICT FK — indexed for the same reason every other RESTRICT FK here is.
    index("cost_components_default_supplier_id_idx").on(table.defaultSupplierId),
    check("cost_components_unit_check", checkIn(table.unit, COST_COMPONENT_UNITS)),
    check("cost_components_cost_type_check", checkIn(table.costType, COST_COMPONENT_TYPES)),
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
    // Composite-FK target for defect_movements (migration 0026): a defect row's SKU always
    // matches its own source batch line.
    unique("production_batch_items_id_sku_key").on(table.id, table.sku),
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
    // Snapshot of costComponents.costType at the moment this line was inserted — see that
    // column's doc comment. Drives how `quantity` below is computed (never typed by hand): a
    // 'variable' line's quantity is always the batch's current total pcs, recomputed on every
    // draft save and re-verified at posting; a 'fixed' line's quantity is always exactly 1 (its
    // unit_price IS the flat amount). No default — always set explicitly at insert.
    costType: text("cost_type").$type<CostComponentType>().notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2, mode: "number" }).notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    total: bigint("total", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(sql`round(quantity * unit_price)`),
    // Migration 0023 (docs/plans/suppliers-goods-receipt.md D9/D28). Who is paid for THIS line —
    // per line, not per batch (sewing by A and finishing by B in one batch). Prefilled from
    // cost_components.default_supplier_id when the line is added, overridable while the batch is
    // a draft. `supplier_name` is a SNAPSHOT of suppliers.name taken whenever the supplier is set
    // (same reasoning as component_name: a tailor renamed later must never rewrite this line).
    // Both nullable: lines from before 0023, and lines nobody attributed, carry neither — the
    // pair check below keeps them together. Frozen once the batch posts by the existing
    // prevent_posted_batch_cost_mutation trigger (migration 0007), which rejects ANY update to a
    // posted batch's cost lines — nothing to change there.
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    supplierName: text("supplier_name"),
    ...createdAtOnly(),
  },
  (table) => [
    index("production_batch_costs_production_batch_id_idx").on(table.productionBatchId),
    // ON DELETE RESTRICT FK — indexed (same reasoning as cost_component_id below), and the
    // future per-supplier payable view (D28) reads by it.
    index("production_batch_costs_supplier_id_idx").on(table.supplierId),
    // Both-or-neither, same idiom as fabrics_price_amount_unit_pair_check. Every pre-0023 row
    // (and every row the previous release inserts) has both NULL, so this holds for them.
    check(
      "production_batch_costs_supplier_pair_check",
      sql`(${table.supplierId} is null) = (${table.supplierName} is null)`,
    ),
    // cost_component_id is NOT NULL + ON DELETE RESTRICT — indexed for the same reason every
    // other FK in this schema is: an unindexed RESTRICT check seq-scans this (append-only,
    // only-grows) table on every cost-component delete attempt.
    index("production_batch_costs_cost_component_id_idx").on(table.costComponentId),
    check("production_batch_costs_quantity_check", sql`${table.quantity} > 0`),
    check("production_batch_costs_unit_price_check", sql`${table.unitPrice} >= 0`),
    check("production_batch_costs_component_unit_check", checkIn(table.componentUnit, COST_COMPONENT_UNITS)),
    check("production_batch_costs_cost_type_check", checkIn(table.costType, COST_COMPONENT_TYPES)),
  ],
);

// The "stock never goes negative" invariant (CLAUDE.md's atomicity rule) is enforced only by
// convention, not by a CHECK on this table — the running balance is a cross-row SUM, which
// Postgres can't express as a row-level constraint. Every writer that can DECREASE a SKU's
// balance MUST lock that SKU's product_variants row (`SELECT ... FOR UPDATE`, see
// lockVariantForUpdate / lockProductForUpdate) BEFORE computing the balance it checks against —
// see adjustStock/saveStockCount in apps/admin/src/lib/stock/queries.ts for the pattern. A
// purely-additive writer (e.g. a production goods receipt in apps/admin/src/lib/receipts/production.ts,
// which only ever inserts positive qty — it locks the variants anyway, for the shared lock order;
// its REVERSAL inserts negative qty and does lock first) is safe without this, but any FUTURE writer that can insert a
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
    // Migration 0011. Mirrors accessory_movements.valueAmount/fabric_stock_movements.valueAmount
    // exactly — current stock VALUE for a SKU is SUM(value_amount), current average cost per pcs
    // is that divided by SUM(qty), same moving-average idiom, computed by the SAME
    // lib/inventory/moving-average.ts functions (they operate on a generic {qty, valueAmount}
    // shape, not anything raw-material-specific):
    //   - 'production': value_amount = qty * the batch line's unit_cost_amount (an inflow with
    //     its own known cost, same role a raw-material 'purchase' plays — this is the ONLY
    //     movement type that moves the average upward with a fresh cost basis). Since migration
    //     0025 (S4) it is written by a GOODS RECEIPT of the batch's output
    //     (ref_type='goods_receipt_item'), never at posting; a receipt reversal writes the exact
    //     negation (negative qty, same ref_type, ref_id = the reversal's item). Rows with
    //     ref_type='production_batch_item' are history from releases that added stock at posting.
    //   - 'sale' (a consumption, negative qty): value_amount =
    //     valueDeltaForConsumption(balanceBeforeLocked, -qty) — valued AT the current average,
    //     snapshotted onto order_items.unit_cost at the same moment (see lib/orders/queries.ts).
    //   - 'return': an EXACT reversal of the 'sale' row for the SAME order_item (same ref_id) —
    //     value_amount is the negation of that row's own value_amount, never recomputed at
    //     whatever the average happens to be when the return posts. Returns are always whole-item
    //     (full qty of the original order_item) — never a partial-quantity return — matching the
    //     (type, ref_type, ref_id) unique index below, which allows exactly one 'sale' and one
    //     'return' row per order_item, not an arbitrary number of partial ones.
    //   - 'adjustment' (manual adjustment or stock count, either sign): same
    //     valueDeltaForConsumption treatment as a raw-material adjustment — see adjustStock/
    //     saveStockCount in apps/admin/src/lib/stock/queries.ts.
    // Backfilled for pre-existing 'production' rows (qty * the referenced production_batch_item's
    // unit_cost_amount) and to 0 for pre-existing 'adjustment' rows in migration 0011 itself —
    // see that migration's hand-authored backfill section (same
    // disable-trigger/UPDATE/re-enable-trigger idiom migration 0010 used for
    // production_batch_costs.cost_type).
    valueAmount: bigint("value_amount", { mode: "number" }).notNull(),
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
    // At most one ledger row per (type, source order_item/production_batch_item/goods_receipt_item)
    // — a retried import, batch save or receipt must not double-count a stock movement for the
    // same source row ('goods_receipt_item' added in migration 0025; the widened predicate is a
    // strict superset of the old one).
    // `type` is part of the key, not just ref_type/ref_id: a sale and a later return of the
    // same order_item legitimately share the same ref_id with different types, and must both
    // be allowed to post. Manual adjustments (ref_type = 'manual') have no single natural
    // source, so they're exempt.
    uniqueIndex("stock_movements_type_ref_unique_idx")
      .on(table.type, table.refType, table.refId)
      .where(sql`${table.refType} in ('order_item', 'production_batch_item', 'goods_receipt_item')`),
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

// ---------- Supplier master — migration 0022 ----------

// The owner's master list of who she buys from and who sews for her
// (docs/plans/suppliers-goods-receipt.md, session 1). Only `name` is required (D13): she often
// knows a Pasar Baru shop by name alone and nothing else, and a master that refuses to store
// that is a master she works around instead of in.
//
// Deliberately NOT retrofitted onto the three existing free-text supplier columns
// (fabrics.supplier, accessory_movements.supplier, fabric_stock_movements.supplier) — those are
// reference labels on rows that already exist, and legacy names are not mapped onto this table
// (D11). The FK columns that make a supplier transactional: cost_components.default_supplier_id
// and production_batch_costs.supplier_id (+ its supplier_name snapshot) arrived in migration
// 0023; purchases.supplier_id arrives later. Each ledger row that gets one keeps a NAME SNAPSHOT, so
// renaming a row here never rewrites history (same reasoning as
// production_batch_costs.component_name).
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // citext, same idiom as cost_components.name: "Laksmi" and "laksmi" are one supplier, not
    // two, and the unique constraint is what guarantees it — never a check-then-insert in
    // application code (CLAUDE.md).
    name: citext("name").notNull().unique(),
    // A SOFT filter only (D13) — see SUPPLIER_KINDS' own doc comment. Reuses products.highlights'
    // exact three-constraint shape (allowed subset + no duplicates + max cardinality) rather
    // than inventing a second array idiom; `text_array_has_duplicates` is the IMMUTABLE helper
    // migration 0018 already created for that purpose (Postgres refuses a subquery inside a
    // CHECK, so the no-duplicates half genuinely needs a function).
    kinds: text("kinds").array().notNull().default(sql`'{}'::text[]`),
    // One field for both calling and WhatsApp — the UI builds a wa.me link from it. Free text,
    // no format CHECK (unlike customers.phone): this is a human-readable note a person dials,
    // and the owner's real supplier contacts include things like "0812-xxx (Bu Ani)".
    phone: text("phone"),
    address: text("address"),
    // Reference text for a human making a transfer — no pair check between the three bank
    // fields on purpose: partial info ("BCA, Laksmi" with the number still on a chat screenshot)
    // is realistic, and refusing it would push her back to notes on paper.
    bankName: text("bank_name"),
    bankAccountNo: text("bank_account_no"),
    bankAccountName: text("bank_account_name"),
    notes: text("notes"),
    // No hard delete, ever, once referenced — "delete" in the UI means setting this false, the
    // same rule cost_components/accessories/fabric_colors already follow. The ON DELETE RESTRICT
    // FKs that later sessions point at this table are the backstop, not the primary guarantee.
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    check("suppliers_kinds_allowed_check", checkArraySubset(table.kinds, SUPPLIER_KINDS)),
    check("suppliers_kinds_no_duplicates_check", sql`not text_array_has_duplicates(${table.kinds})`),
    check("suppliers_kinds_max_check", sql`cardinality(${table.kinds}) <= ${sql.raw(String(SUPPLIER_KINDS.length))}`),
  ],
);

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
    // Migration 0024 (docs/plans/suppliers-goods-receipt.md §3.4). Set on the 'purchase' row a
    // goods receipt writes (and on its reversal's 'purchase_void' row), naming the purchase
    // document's supplier; the free-text `supplier` above is written alongside it with the
    // supplier's NAME AT RECEIPT TIME, a snapshot a later rename never rewrites. Nullable: legacy
    // single-row purchases, adjustments and consumptions have none.
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("accessory_movements_accessory_id_created_at_idx").on(table.accessoryId, table.createdAt),
    index("accessory_movements_ref_idx").on(table.refType, table.refId),
    index("accessory_movements_supplier_id_idx").on(table.supplierId),
    // At most one ledger row per (type, receipt line) — a double-posted receipt is impossible at
    // the DB level, mirroring stock_movements_type_ref_unique_idx (migration 0024).
    uniqueIndex("accessory_movements_goods_receipt_ref_unique_idx")
      .on(table.type, table.refType, table.refId)
      .where(sql`${table.refType} = 'goods_receipt'`),
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
    // Migration 0024 — see accessory_movements.supplierId.
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("fabric_stock_movements_fabric_id_created_at_idx").on(table.fabricId, table.createdAt),
    index("fabric_stock_movements_ref_idx").on(table.refType, table.refId),
    index("fabric_stock_movements_supplier_id_idx").on(table.supplierId),
    // See accessory_movements_goods_receipt_ref_unique_idx.
    uniqueIndex("fabric_stock_movements_goods_receipt_ref_unique_idx")
      .on(table.type, table.refType, table.refId)
      .where(sql`${table.refType} = 'goods_receipt'`),
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
    // Deferred from migration 0008 (leftmost index for the ON DELETE RESTRICT check against
    // accessories, same reasoning every other RESTRICT-FK index in this schema gives — an
    // unindexed check seq-scans this table on every accessory delete attempt).
    index("product_accessory_recipes_accessory_id_idx").on(table.accessoryId),
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
    // Deferred from migration 0008 — same reasoning as
    // product_accessory_recipes_accessory_id_idx above (the unique constraint's own index
    // leads with production_batch_id, not accessory_id, so it doesn't cover this RESTRICT
    // check's leftmost-prefix need).
    index("production_batch_accessory_overrides_accessory_id_idx").on(table.accessoryId),
    check("production_batch_accessory_overrides_override_qty_check", sql`${table.overrideQty} >= 0`),
  ],
);

// ---------- Purchase documents + goods receipts — migration 0024 ----------
// docs/plans/suppliers-goods-receipt.md §3.2/§3.3, session S3.

// A purchase is a real document (D1): a header naming the supplier, and lines naming what was
// ordered. Recording one moves NO stock — stock moves only when goods are received against it
// (goods_receipts below, D3). Legacy single-row purchases (a type='purchase' ledger row with no
// ref_type='goods_receipt') stay exactly as they are and are never backfilled into documents
// (D11).
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // PO-YYYYMM-NNN, generated under a per-month advisory lock (lib/documents/document-number.ts);
    // the unique constraint is the backstop.
    purchaseNo: text("purchase_no").notNull().unique(),
    // NOT NULL: every purchase document names a supplier from the master. Legacy free-text
    // supplier names are not mapped onto it (D11).
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    // The day she placed the order (Asia/Jakarta calendar date, a display/reporting label).
    orderedAt: date("ordered_at", { mode: "string" }).notNull(),
    notes: text("notes"),
    // Recomputed from the receipts after every receipt/reversal (ordered/partially_received/
    // received); closed/cancelled only by the close action (D19).
    status: text("status").$type<PurchaseStatus>().notNull().default("ordered"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    closedByStaffUserId: uuid("closed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    closeReason: text("close_reason"),
    // Re-open (D18, migration 0027): only a return-to-supplier against a closed/cancelled document
    // re-opens it, stamping who, when and why. The latest re-open wins; the close stamp above is
    // kept (one-directional close check), so both events stay visible.
    reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: "date" }),
    reopenedByStaffUserId: uuid("reopened_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    reopenReason: text("reopen_reason"),
    createdByStaffUserId: uuid("created_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("purchases_supplier_id_idx").on(table.supplierId),
    index("purchases_status_idx").on(table.status),
    index("purchases_ordered_at_idx").on(table.orderedAt.desc()),
    index("purchases_closed_by_staff_user_id_idx").on(table.closedByStaffUserId),
    index("purchases_reopened_by_staff_user_id_idx").on(table.reopenedByStaffUserId),
    // All three re-open columns or none, and a reason is never blank.
    check(
      "purchases_reopened_triple_check",
      sql`num_nonnulls(${table.reopenedAt}, ${table.reopenedByStaffUserId}, ${table.reopenReason}) in (0, 3) and (${table.reopenReason} is null or btrim(${table.reopenReason}) <> '')`,
    ),
    index("purchases_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    check("purchases_status_check", checkIn(table.status, PURCHASE_STATUSES)),
    // One-directional on purpose (§3.2): a terminal status always carries its close stamp, but a
    // document re-opened later (D18, S6) keeps the record of its last close.
    check(
      "purchases_closed_status_check",
      sql`${table.status} not in ('closed', 'cancelled') or ${table.closedAt} is not null`,
    ),
    check(
      "purchases_closed_pair_check",
      sql`(${table.closedAt} is not null) = (${table.closedByStaffUserId} is not null)`,
    ),
  ],
);

// One line of a purchase document. `qty_ordered` + `total_amount` are exactly what the owner
// typed (D6, ongkir INCLUDED) — never a unit price. Each receipt is valued as a cumulative-rounding
// slice of `total_amount` (lib/receipts/valuation.ts), so partial receipts sum to exactly what was
// paid. No qty_received column: received quantities are always SUMs over goods_receipt_items,
// never a mutable counter. Frozen once it has a non-reversed receipt item
// (prevent_received_purchase_item_change, migration 0024, D7).
export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    itemType: text("item_type").$type<PurchaseItemType>().notNull(),
    fabricId: uuid("fabric_id").references(() => fabrics.id, { onDelete: "restrict" }),
    accessoryId: uuid("accessory_id").references(() => accessories.id, { onDelete: "restrict" }),
    // Yards (2 decimals, matching fabric_stock_movements.qty) or whole pcs (CHECK below).
    qtyOrdered: numeric("qty_ordered", { precision: 10, scale: 2, mode: "number" }).notNull(),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    ...createdAtOnly(),
  },
  (table) => [
    index("purchase_items_purchase_id_idx").on(table.purchaseId),
    index("purchase_items_fabric_id_idx").on(table.fabricId),
    index("purchase_items_accessory_id_idx").on(table.accessoryId),
    check("purchase_items_item_type_check", checkIn(table.itemType, PURCHASE_ITEM_TYPES)),
    // Exactly one target, agreeing with item_type — same idiom as product_accessory_recipes.
    check(
      "purchase_items_exactly_one_target_check",
      sql`(${table.fabricId} is null) <> (${table.accessoryId} is null) and (${table.itemType} = 'fabric') = (${table.fabricId} is not null)`,
    ),
    check("purchase_items_qty_ordered_check", sql`${table.qtyOrdered} > 0`),
    check(
      "purchase_items_accessory_whole_qty_check",
      sql`${table.itemType} <> 'accessory' or ${table.qtyOrdered} = round(${table.qtyOrdered})`,
    ),
    check("purchase_items_total_amount_check", sql`${table.totalAmount} >= 0`),
    // The same item cannot appear twice in one purchase.
    uniqueIndex("purchase_items_purchase_id_fabric_id_key")
      .on(table.purchaseId, table.fabricId)
      .where(sql`${table.fabricId} is not null`),
    uniqueIndex("purchase_items_purchase_id_accessory_id_key")
      .on(table.purchaseId, table.accessoryId)
      .where(sql`${table.accessoryId} is not null`),
    // Composite-FK targets for defect_movements (migration 0026, §3.2): a defect row's fabric/
    // accessory always matches its own source purchase line. Nullable columns are fine as FK
    // targets under MATCH SIMPLE, exactly as product_images_fabric_color_fabric_fk relies on.
    unique("purchase_items_id_fabric_id_key").on(table.id, table.fabricId),
    unique("purchase_items_id_accessory_id_key").on(table.id, table.accessoryId),
  ],
);

// One receipt (or one reversal of a receipt) against a purchase or, from S4, a production batch
// (D2). Append-only by design: a wrong receipt is corrected by a `kind='reversal'` receipt that
// negates it exactly (D8), never edited; the original only gains `reversed_at`/
// `reversed_by_staff_user_id`, once.
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // GR-YYYYMM-NNN, same generator as purchase_no.
    receiptNo: text("receipt_no").notNull().unique(),
    sourceType: text("source_type").$type<GoodsReceiptSourceType>().notNull(),
    purchaseId: uuid("purchase_id").references(() => purchases.id, { onDelete: "restrict" }),
    productionBatchId: uuid("production_batch_id").references(() => productionBatches.id, { onDelete: "restrict" }),
    kind: text("kind").$type<GoodsReceiptKind>().notNull(),
    // The day the goods physically arrived (Asia/Jakarta). Defaults to today in the form,
    // backdatable (D21) — a display/reporting label only; the ledger's own order stays insertion
    // order.
    receivedAt: date("received_at", { mode: "string" }).notNull(),
    // Only for "someone else physically took delivery"; the real actor is always
    // created_by_staff_user_id (D21).
    receivedByName: text("received_by_name"),
    reversesReceiptId: uuid("reverses_receipt_id").references((): AnyPgColumn => goodsReceipts.id, {
      onDelete: "restrict",
    }),
    reversedAt: timestamp("reversed_at", { withTimezone: true, mode: "date" }),
    reversedByStaffUserId: uuid("reversed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    note: text("note"),
    createdByStaffUserId: uuid("created_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("goods_receipts_purchase_id_created_at_idx").on(table.purchaseId, table.createdAt),
    index("goods_receipts_production_batch_id_created_at_idx").on(table.productionBatchId, table.createdAt),
    index("goods_receipts_received_at_idx").on(table.receivedAt.desc()),
    index("goods_receipts_reversed_by_staff_user_id_idx").on(table.reversedByStaffUserId),
    index("goods_receipts_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    // Doubles as the index behind the self-FK's RESTRICT check, and as the "one reversal per
    // receipt" guarantee.
    unique("goods_receipts_reverses_receipt_id_key").on(table.reversesReceiptId),
    // Composite-FK target for goods_receipt_items (an item can never disagree with its header).
    unique("goods_receipts_id_source_type_kind_key").on(table.id, table.sourceType, table.kind),
    check("goods_receipts_source_type_check", checkIn(table.sourceType, GOODS_RECEIPT_SOURCE_TYPES)),
    check("goods_receipts_kind_check", checkIn(table.kind, GOODS_RECEIPT_KINDS)),
    check(
      "goods_receipts_exactly_one_source_check",
      sql`(${table.purchaseId} is null) <> (${table.productionBatchId} is null) and (${table.sourceType} = 'purchase') = (${table.purchaseId} is not null)`,
    ),
    // Mirror accessory_movements' void columns exactly.
    check(
      "goods_receipts_reverses_receipt_id_pair_check",
      sql`(${table.kind} = 'reversal') = (${table.reversesReceiptId} is not null)`,
    ),
    check(
      "goods_receipts_reversed_pair_check",
      sql`(${table.reversedAt} is not null) = (${table.reversedByStaffUserId} is not null)`,
    ),
    check("goods_receipts_reversed_at_kind_check", sql`${table.reversedAt} is null or ${table.kind} = 'receipt'`),
  ],
);

// One line of a receipt. `qty_accepted` is deliberately NOT named qty_received: "received" is
// accepted + rejected. `qty_rejected` (migration 0026, S5) is what arrived defective; it is
// mirrored 1:1 into a defect_movements 'reject' row in the same transaction and never enters
// sellable stock. Signed: a reversal item is the exact negation of the original's, so every
// per-line balance stays a plain SUM.
export const goodsReceiptItems = pgTable(
  "goods_receipt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No single-column FK — superseded by the composite goods_receipt_items_receipt_fk below.
    goodsReceiptId: uuid("goods_receipt_id").notNull(),
    // Denormalized copies of the header's source_type/kind, existing ONLY so the composite FK
    // guarantees this item agrees with its own header (same technique as
    // production_batch_items.fabric_id).
    sourceType: text("source_type").$type<GoodsReceiptSourceType>().notNull(),
    kind: text("kind").$type<GoodsReceiptKind>().notNull(),
    purchaseItemId: uuid("purchase_item_id").references(() => purchaseItems.id, { onDelete: "restrict" }),
    productionBatchItemId: uuid("production_batch_item_id").references(() => productionBatchItems.id, {
      onDelete: "restrict",
    }),
    qtyAccepted: numeric("qty_accepted", { precision: 10, scale: 2, mode: "number" }).notNull(),
    // Defaulted, so the previous release's inserts (which never name it) stay valid (expand/
    // contract) and every pre-0026 row reads as "nothing rejected".
    qtyRejected: numeric("qty_rejected", { precision: 10, scale: 2, mode: "number" }).notNull().default(0),
    ...createdAtOnly(),
  },
  (table) => [
    index("goods_receipt_items_goods_receipt_id_idx").on(table.goodsReceiptId),
    // Back the per-line SUM and the RESTRICT checks.
    index("goods_receipt_items_purchase_item_id_idx").on(table.purchaseItemId),
    index("goods_receipt_items_production_batch_item_id_idx").on(table.productionBatchItemId),
    // Composite-FK targets (migration 0027) for defect_movements: a reject (and a reject's
    // reversal) must name a receipt item of its OWN source line. Always satisfiable — `id` is the
    // primary key.
    unique("goods_receipt_items_id_purchase_item_id_key").on(table.id, table.purchaseItemId),
    unique("goods_receipt_items_id_production_batch_item_id_key").on(table.id, table.productionBatchItemId),
    foreignKey({
      columns: [table.goodsReceiptId, table.sourceType, table.kind],
      foreignColumns: [goodsReceipts.id, goodsReceipts.sourceType, goodsReceipts.kind],
      name: "goods_receipt_items_receipt_fk",
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    check("goods_receipt_items_source_type_check", checkIn(table.sourceType, GOODS_RECEIPT_SOURCE_TYPES)),
    check("goods_receipt_items_kind_check", checkIn(table.kind, GOODS_RECEIPT_KINDS)),
    check(
      "goods_receipt_items_exactly_one_source_check",
      sql`(${table.purchaseItemId} is null) <> (${table.productionBatchItemId} is null) and (${table.sourceType} = 'purchase') = (${table.purchaseItemId} is not null)`,
    ),
    // A receipt adds, a reversal removes (§3.3), for both quantities. Written as >= 0 / <= 0 plus
    // a separate "must do something" check, because a line may legitimately accept 0 and reject
    // 2. Migration 0026 widened the nonzero check from `qty_accepted <> 0` to the sum (a strict
    // superset of the old predicate for every row the previous release writes).
    check(
      "goods_receipt_items_qty_accepted_sign_check",
      sql`(${table.kind} = 'receipt' and ${table.qtyAccepted} >= 0) or (${table.kind} = 'reversal' and ${table.qtyAccepted} <= 0)`,
    ),
    check(
      "goods_receipt_items_qty_rejected_sign_check",
      sql`(${table.kind} = 'receipt' and ${table.qtyRejected} >= 0) or (${table.kind} = 'reversal' and ${table.qtyRejected} <= 0)`,
    ),
    check("goods_receipt_items_qty_nonzero_check", sql`${table.qtyAccepted} + ${table.qtyRejected} <> 0`),
    // Production output is whole pcs. Accessory purchase lines are whole pcs too, enforced in the
    // receipt code (this row doesn't know its purchase line's item_type) and by
    // purchase_items_accessory_whole_qty_check on the ordered side.
    check(
      "goods_receipt_items_production_whole_qty_check",
      sql`${table.sourceType} <> 'production_batch' or ${table.qtyAccepted} = round(${table.qtyAccepted})`,
    ),
    check(
      "goods_receipt_items_production_whole_rejected_check",
      sql`${table.sourceType} <> 'production_batch' or ${table.qtyRejected} = round(${table.qtyRejected})`,
    ),
    // One line per source line per receipt.
    uniqueIndex("goods_receipt_items_receipt_purchase_item_key")
      .on(table.goodsReceiptId, table.purchaseItemId)
      .where(sql`${table.purchaseItemId} is not null`),
    uniqueIndex("goods_receipt_items_receipt_batch_item_key")
      .on(table.goodsReceiptId, table.productionBatchItemId)
      .where(sql`${table.productionBatchItemId} is not null`),
  ],
);

// ---------- Defect stock — migration 0026 ----------
// docs/plans/suppliers-goods-receipt.md §3.5, D14/D23, session S5.

// The append-only ledger of DEFECT stock (stok barang cacat) for all three item kinds. A separate
// table on purpose (D14), not an is_defect flag on the sellable ledgers: no existing query over
// stock_movements / accessory_movements / fabric_stock_movements can ever see these units, so
// "never sellable, never ordered, never packed, never counted as sellable" is structural rather
// than a WHERE clause every reader would have to remember. Only the stock pages, the source
// documents and /stock/defects read it, deliberately.
//
// Defect stock is its own moving-average pool per item (D23): balance = SUM(qty), value =
// SUM(value_amount), never a stored counter, exactly like every other ledger here.
//   - 'reject' (S5): units that arrived defective at a goods receipt, one row per receipt line
//     with qty_rejected > 0 (1:1, enforced by the partial unique index below), valued at the
//     defect share of the line's §4.2 slice (purchases) or qty x the frozen unit_cost_amount
//     (production). Rejects never touch the sellable average that feeds HPP.
//   - 'return_out' / 'dispose' (S6): outflows valued through valueDeltaForConsumption at this
//     pool's own average. Nothing writes them until S6; the columns and CHECKs ship now so S6 needs
//     no CHECK migration.
//   - 'reversal': the exact negation of one earlier row (D8), copying its item, source-line and
//     disposal columns so every per-line / per-type SUM nets without a self-join. A reversal of a
//     'reject' points goods_receipt_item_id at the REVERSAL receipt's item (same convention the
//     raw-material ledgers' ref_id follows).
// Per-line rule the receipt code relies on (lib/defects/queries.ts): rows with disposal_type NULL
// are exactly the rejects, returns and their reversals, i.e. the part of qtySettled (§4.2, D16)
// that lives in this ledger; rows with disposal_type set are releases and their reversals, which
// never change qtySettled.
//
// DB-immutable (prevent_defect_movement_mutation, hand-authored in migration 0026): DELETE is
// always rejected; UPDATE only for reversed_at/reversed_by_staff_user_id, from NULL, once.
export const defectMovements = pgTable(
  "defect_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemKind: text("item_kind").$type<DefectItemKind>().notNull(),
    // The balance key: exactly one is set, agreeing with item_kind. Denormalized (rather than
    // joined through the source line) for the same reason production_batch_items.fabric_id is.
    sku: text("sku").references(() => productVariants.sku, { onDelete: "restrict" }),
    fabricId: uuid("fabric_id").references(() => fabrics.id, { onDelete: "restrict" }),
    accessoryId: uuid("accessory_id").references(() => accessories.id, { onDelete: "restrict" }),
    type: text("type").$type<DefectMovementType>().notNull(),
    // Yards (2 decimals) for fabric, whole pcs otherwise (CHECK below). Signed.
    qty: numeric("qty", { precision: 10, scale: 2, mode: "number" }).notNull(),
    valueAmount: bigint("value_amount", { mode: "number" }).notNull(),
    goodsReceiptItemId: uuid("goods_receipt_item_id").references(() => goodsReceiptItems.id, { onDelete: "restrict" }),
    // The source LINE, always set (exactly one). No single-column FKs: superseded by the
    // composite FKs below, which also guarantee the item matches the line (same consolidation
    // production_batch_items uses for its own batch/sku columns).
    purchaseItemId: uuid("purchase_item_id"),
    productionBatchItemId: uuid("production_batch_item_id"),
    disposalType: text("disposal_type").$type<DefectDisposalType>(),
    // Whole rupiah, gross cash actually received (D24). Stored, never booked: no journal entry
    // anywhere. Deliberately NOT netted against value_amount (which is the COST that left the
    // pool). Signed: a reversal carries the exact negation.
    proceedsAmount: bigint("proceeds_amount", { mode: "number" }),
    // Asia/Jakarta calendar date (the receipt's received_at for a 'reject'); a display/reporting
    // label only, the ledger's own order stays insertion order.
    occurredAt: date("occurred_at", { mode: "string" }).notNull(),
    reversesMovementId: uuid("reverses_movement_id").references((): AnyPgColumn => defectMovements.id, {
      onDelete: "restrict",
    }),
    reversedAt: timestamp("reversed_at", { withTimezone: true, mode: "date" }),
    reversedByStaffUserId: uuid("reversed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    note: text("note"),
    createdByStaffUserId: uuid("created_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    ...createdAtOnly(),
  },
  (table) => [
    // The balance query's shape (WHERE item = ? ORDER BY created_at), and the leftmost index each
    // item column's ON DELETE RESTRICT check needs. item_kind is not a leading column: a non-null
    // item column already implies its kind.
    index("defect_movements_sku_created_at_idx").on(table.sku, table.createdAt),
    index("defect_movements_fabric_id_created_at_idx").on(table.fabricId, table.createdAt),
    index("defect_movements_accessory_id_created_at_idx").on(table.accessoryId, table.createdAt),
    index("defect_movements_purchase_item_id_idx").on(table.purchaseItemId),
    index("defect_movements_production_batch_item_id_idx").on(table.productionBatchItemId),
    index("defect_movements_goods_receipt_item_id_idx").on(table.goodsReceiptItemId),
    index("defect_movements_reversed_by_staff_user_id_idx").on(table.reversedByStaffUserId),
    index("defect_movements_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    // One 'reject' movement per receipt line: a double-posted reject is impossible at the DB level.
    uniqueIndex("defect_movements_reject_goods_receipt_item_unique_idx")
      .on(table.goodsReceiptItemId)
      .where(sql`${table.type} = 'reject'`),
    // One reversal per movement; doubles as the self-FK's RESTRICT index.
    unique("defect_movements_reverses_movement_id_key").on(table.reversesMovementId),
    foreignKey({
      columns: [table.purchaseItemId, table.fabricId],
      foreignColumns: [purchaseItems.id, purchaseItems.fabricId],
      name: "defect_movements_purchase_item_fabric_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.purchaseItemId, table.accessoryId],
      foreignColumns: [purchaseItems.id, purchaseItems.accessoryId],
      name: "defect_movements_purchase_item_accessory_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.productionBatchItemId, table.sku],
      foreignColumns: [productionBatchItems.id, productionBatchItems.sku],
      name: "defect_movements_production_batch_item_sku_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // Migration 0027: the receipt item a reject (or a reject's reversal) names belongs to the same
    // source line as the row itself. MATCH SIMPLE: rows without a receipt item (returns, releases
    // and their reversals) or of the other source kind skip the check.
    foreignKey({
      columns: [table.goodsReceiptItemId, table.purchaseItemId],
      foreignColumns: [goodsReceiptItems.id, goodsReceiptItems.purchaseItemId],
      name: "defect_movements_receipt_item_purchase_item_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.goodsReceiptItemId, table.productionBatchItemId],
      foreignColumns: [goodsReceiptItems.id, goodsReceiptItems.productionBatchItemId],
      name: "defect_movements_receipt_item_batch_item_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("defect_movements_item_kind_check", checkIn(table.itemKind, DEFECT_ITEM_KINDS)),
    check(
      "defect_movements_exactly_one_item_check",
      sql`num_nonnulls(${table.sku}, ${table.fabricId}, ${table.accessoryId}) = 1 and (${table.itemKind} = 'sku') = (${table.sku} is not null) and (${table.itemKind} = 'fabric') = (${table.fabricId} is not null) and (${table.itemKind} = 'accessory') = (${table.accessoryId} is not null)`,
    ),
    // Exactly one source line, of the kind the item implies (a SKU comes from a batch line, a
    // fabric/accessory from a purchase line) — together with exactly_one_item this makes the
    // matching composite FK above always apply.
    check(
      "defect_movements_exactly_one_source_check",
      sql`(${table.purchaseItemId} is null) <> (${table.productionBatchItemId} is null) and (${table.itemKind} = 'sku') = (${table.productionBatchItemId} is not null)`,
    ),
    check("defect_movements_type_check", checkIn(table.type, DEFECT_MOVEMENT_TYPES)),
    check("defect_movements_qty_nonzero_check", sql`${table.qty} <> 0`),
    check("defect_movements_reject_qty_check", sql`${table.type} <> 'reject' or ${table.qty} > 0`),
    check("defect_movements_outflow_qty_check", sql`${table.type} not in ('return_out', 'dispose') or ${table.qty} < 0`),
    check("defect_movements_whole_qty_check", sql`${table.itemKind} = 'fabric' or ${table.qty} = round(${table.qty})`),
    check(
      "defect_movements_reject_receipt_item_check",
      sql`${table.type} <> 'reject' or ${table.goodsReceiptItemId} is not null`,
    ),
    check("defect_movements_disposal_type_check", checkIn(table.disposalType, DEFECT_DISPOSAL_TYPES)),
    check(
      "defect_movements_disposal_type_movement_check",
      sql`${table.disposalType} is null or ${table.type} in ('dispose', 'reversal')`,
    ),
    check("defect_movements_dispose_has_type_check", sql`${table.type} <> 'dispose' or ${table.disposalType} is not null`),
    // Both or neither, same idiom as fabrics_price_amount_unit_pair_check.
    check(
      "defect_movements_proceeds_pair_check",
      sql`(${table.disposalType} is null) = (${table.proceedsAmount} is null)`,
    ),
    check(
      "defect_movements_auction_proceeds_check",
      sql`${table.type} <> 'dispose' or ${table.disposalType} <> 'auction' or ${table.proceedsAmount} > 0`,
    ),
    // Hibah and Dibuang/Dimusnahkan are both exactly Rp 0 (D24, D29).
    check(
      "defect_movements_zero_proceeds_check",
      sql`${table.type} <> 'dispose' or ${table.disposalType} not in ('donation', 'discarded') or ${table.proceedsAmount} = 0`,
    ),
    check(
      "defect_movements_dispose_note_check",
      sql`${table.type} <> 'dispose' or (${table.note} is not null and btrim(${table.note}) <> '')`,
    ),
    // Mirror goods_receipts' reversal columns exactly.
    check(
      "defect_movements_reverses_movement_id_pair_check",
      sql`(${table.type} = 'reversal') = (${table.reversesMovementId} is not null)`,
    ),
    check(
      "defect_movements_reversed_pair_check",
      sql`(${table.reversedAt} is not null) = (${table.reversedByStaffUserId} is not null)`,
    ),
    check("defect_movements_reversed_at_type_check", sql`${table.reversedAt} is null or ${table.type} <> 'reversal'`),
  ],
);
