// Single source of truth for every "status/type" column's allowed values. Each array backs a
// database CHECK constraint (see the table definitions) AND is importable by application code —
// never duplicate these lists elsewhere.

// "ALLSIZE" is a real size for a one-size-fits-all product (products.size_mode = 'all_size'),
// not a cutting size — it is deliberately excluded from CUTTING_SIZES/CUTTING_RATIO below, and
// from the Overview dashboard's size-mix-vs-cutting-ratio metric (docs/SPEC.md §6).
export const SIZES = ["XS", "S", "M", "L", "XL", "ALLSIZE"] as const;
export type Size = (typeof SIZES)[number];

export const SIZE_MODES = ["sized", "all_size"] as const;
export type SizeMode = (typeof SIZE_MODES)[number];

export const PRODUCT_CLOSURES = ["front_zip", "back_zip"] as const;
export type ProductClosure = (typeof PRODUCT_CLOSURES)[number];

export const FABRIC_PRICE_UNITS = ["meter", "yard"] as const;
export type FabricPriceUnit = (typeof FABRIC_PRICE_UNITS)[number];

export const STOCK_MOVEMENT_TYPES = ["production", "sale", "return", "adjustment"] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_MOVEMENT_REF_TYPES = ["production_batch_item", "order_item", "manual"] as const;
export type StockMovementRefType = (typeof STOCK_MOVEMENT_REF_TYPES)[number];

/** Only ever set when `type = 'adjustment'` — see stock_movements_reason_adjustment_pair_check
 * (migration 0006). */
export const STOCK_ADJUSTMENT_REASONS = ["recount", "damaged", "lost", "other"] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

export const PRODUCTION_BATCH_STATUSES = ["draft", "posted"] as const;
export type ProductionBatchStatus = (typeof PRODUCTION_BATCH_STATUSES)[number];

/** Units a cost_components row (and the production_batch_costs lines that snapshot it) can be
 * priced per. "lusin" = a dozen — Pasar Baru suppliers commonly quote accessories this way. */
export const COST_COMPONENT_UNITS = ["pcs", "meter", "yard", "lusin", "set"] as const;
export type CostComponentUnit = (typeof COST_COMPONENT_UNITS)[number];

/** Whether a cost_components row (and the production_batch_costs lines that snapshot it) scales
 * with a batch's pcs count ("variable", e.g. "Ongkos jahit" — priced per pcs, so its total is
 * unit_price × the batch's total pcs) or is a single flat amount per batch regardless of pcs
 * ("fixed", e.g. a one-off tooling fee — stored as quantity=1 × unit_price). See postBatch/
 * syncExtraCostLines in apps/admin's lib/production/queries.ts for where this distinction
 * controls how `quantity` is computed (never typed by hand for either kind). */
export const COST_COMPONENT_TYPES = ["variable", "fixed"] as const;
export type CostComponentType = (typeof COST_COMPONENT_TYPES)[number];

/** Shared between accessory_movements and fabric_stock_movements (migration 0008) — both ledgers
 * use the exact same movement vocabulary. "purchase_void" is a reversal row, never a hard
 * edit/delete of the original "purchase" row (see accessory_movements' own doc comment). */
export const RAW_MATERIAL_MOVEMENT_TYPES = ["purchase", "purchase_void", "production", "adjustment"] as const;
export type RawMaterialMovementType = (typeof RAW_MATERIAL_MOVEMENT_TYPES)[number];

/** Mirrors stock_movements' own ref_type idiom, scoped to what can actually consume/reference a
 * raw-material item: a production batch (aggregated consumption, not per line — see queries) or
 * a manual purchase/adjustment/void with no single natural source row. */
export const RAW_MATERIAL_MOVEMENT_REF_TYPES = ["production_batch", "manual"] as const;
export type RawMaterialMovementRefType = (typeof RAW_MATERIAL_MOVEMENT_REF_TYPES)[number];

/** "shopee"/"tiktok" are the two marketplace channels a future importer reconciles against —
 * `channel_order_no` is required for these (validated in app code, see lib/orders/queries.ts)
 * so a later import of the same order updates via the existing unique key instead of duplicating
 * it. "whatsapp"/"instagram"/"offline" are manual-entry-only channels (no external order number
 * ever exists for them); "web" is reserved for the Dec 2026 main-site checkout. */
export const CHANNEL_IDS = ["shopee", "tiktok", "web", "reseller", "whatsapp", "instagram", "offline"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** Channels whose orders always originate from a marketplace with its own order numbering —
 * `channel_order_no` is required (not just optionally present) for these, specifically so a
 * future Shopee/TikTok importer's re-import of the same order hits
 * `orders_channel_id_channel_order_no_key` and updates in place rather than inserting a
 * duplicate. See orders.ts's doc comment on `channelOrderNo`. */
export const MARKETPLACE_CHANNEL_IDS: readonly ChannelId[] = ["shopee", "tiktok"];

export const ORDER_STATUSES = [
  "awaiting_payment",
  "to_ship",
  "shipped",
  "completed",
  "cancelled",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const IMPORT_BATCH_KINDS = ["orders", "income"] as const;
export type ImportBatchKind = (typeof IMPORT_BATCH_KINDS)[number];

export const IMPORT_BATCH_STATUSES = ["pending", "previewed", "committed", "failed"] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const EXPENSE_CATEGORIES = [
  "packaging",
  "shipping",
  "tools",
  "salary",
  "operational",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CUSTOMER_TYPES = ["retail", "reseller"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const THANK_YOU_CARD_STATUSES = ["active", "claimed", "void"] as const;
export type ThankYouCardStatus = (typeof THANK_YOU_CARD_STATUSES)[number];

export const VOUCHER_STATUSES = ["active", "used", "expired", "void"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

/** The cutting sizes — every size except ALLSIZE, which has no place in a cutting ratio. */
export const CUTTING_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type CuttingSize = (typeof CUTTING_SIZES)[number];

/**
 * The fixed cutting ratio per fabric roll (docs/SPEC.md §6): XS2-S4-M4-L3-XL2. A business
 * constant, not stored per fabric — used by the Overview dashboard to flag size-mix gaps
 * greater than 10 percentage points from this ratio. Typed by `CuttingSize`, not `Size`, so an
 * ALLSIZE variant can never be looked up here — ALLSIZE products are excluded from this metric
 * entirely (docs/SPEC.md §6).
 */
export const CUTTING_RATIO: Record<CuttingSize, number> = {
  XS: 2,
  S: 4,
  M: 4,
  L: 3,
  XL: 2,
};
