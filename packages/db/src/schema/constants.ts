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

// A FIXED set, not free text (owner requirement) — the future storefront maps each key to its
// own icon, which only works for a closed set. This array IS the canonical display order
// everywhere (admin checkboxes, storefront badges); nothing else decides ordering. Labels
// (Indonesian display text) are NOT here — see packages/db/src/catalog/highlights.ts, which
// imports this array; they're UI copy, never stored in the DB, so a label can be reworded
// without a migration.
export const PRODUCT_HIGHLIGHT_KEYS = ["breathable", "flowy", "falls_perfectly", "cool_fabric", "not_see_through"] as const;
export type ProductHighlightKey = (typeof PRODUCT_HIGHLIGHT_KEYS)[number];

export const FABRIC_PRICE_UNITS = ["meter", "yard"] as const;
export type FabricPriceUnit = (typeof FABRIC_PRICE_UNITS)[number];

// The homepage's 4 fixed sections (docs/plans/storefront-cms.md) — a fixed set, never a generic
// page-builder set of arbitrary sections. Backs storefront_homepage_sections.key's CHECK
// constraint (schema/content.ts); the 4 rows themselves are seeded by a migration (0019), not
// seed.ts, per CLAUDE.md's "reference data the code depends on ships in a migration" rule — the
// storefront can't render without these rows existing, same category as a permission key or a
// channel id.
export const HOMEPAGE_SECTION_KEYS = ["hero", "product_grid", "feature_block", "why_ammari"] as const;
export type HomepageSectionKey = (typeof HOMEPAGE_SECTION_KEYS)[number];

// Phase 2 (docs/plans/storefront-cms.md, session 8) — a fixed set of 5 info-page slugs, not a
// generic page builder, same "closed set, seeded by migration" reasoning as
// HOMEPAGE_SECTION_KEYS above. "privacy-policy"/"terms-of-service" already exist as hard-coded
// routes in apps/web (registered in the Google OAuth consent screen) and MUST keep these exact
// slugs/URLs; "returns-exchange"/"how-to-order"/"shipping" already exist as placeholder routes
// from session 7. Backs info_pages.slug's CHECK constraint (schema/content.ts); the 5 rows are
// seeded by migration 0020, not seed.ts, per CLAUDE.md's "reference data the code depends on
// ships in a migration" rule.
export const INFO_PAGE_SLUGS = ["privacy-policy", "terms-of-service", "returns-exchange", "how-to-order", "shipping"] as const;
export type InfoPageSlug = (typeof INFO_PAGE_SLUGS)[number];

// A FIXED set of "Kenapa Ammari" icon keys (docs/plans/storefront-cms.md), same "closed set, not
// free text" reasoning as PRODUCT_HIGHLIGHT_KEYS below — each key maps to one lucide-react icon
// in apps/web. Not backed by its own DB CHECK: it lives inside a `why_ammari` JSONB content
// value's `points[].icon` field (storefront_homepage_sections.draft_content/published_content),
// not a dedicated column, so this set is enforced by the per-key Zod schema at save time instead
// (a later session), not by Postgres — confirmed by grepping every shipped migration for these
// key strings (none found) before this set was last revised, so revising it needs no migration.
// Labels live in packages/db/src/catalog/why-ammari.ts, same key↔label/key↔icon split
// PRODUCT_HIGHLIGHT_KEYS already uses. `bandung_made`/`trusted_by_customers` were dropped (owner
// decision): no city mention on the storefront, and no unverifiable customer-count claim.
export const WHY_AMMARI_ICON_KEYS = [
  "syari_design",
  "premium_fabric",
  "careful_tailoring",
  "all_day_comfort",
  "easy_care",
  "not_see_through",
  "nursing_friendly",
  "responsive_service",
] as const;
export type WhyAmmariIconKey = (typeof WHY_AMMARI_ICON_KEYS)[number];

/** What a supplier supplies (docs/plans/suppliers-goods-receipt.md D13) — a SOFT filter only,
 * never a restriction: a picker sorts matching kinds first but must never refuse a supplier
 * whose `kinds` don't list the kind being bought, because the owner's real suppliers don't
 * respect those boundaries (a fabric shop that also sells buttons). Backs suppliers.kinds'
 * subset CHECK; empty is valid and means "not categorized yet". Indonesian labels live in
 * apps/admin's lib/suppliers/kinds.ts, never in the DB — same key↔label split
 * PRODUCT_HIGHLIGHT_KEYS already uses, so wording changes need no migration. */
export const SUPPLIER_KINDS = ["fabric", "accessory", "service", "other"] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];

/** A purchase document's lifecycle (docs/plans/suppliers-goods-receipt.md §3.2). No `draft`: the
 * owner records purchases she has already placed. `ordered` → `partially_received` → `received`
 * is recomputed from the receipts after every receipt and reversal; `closed`/`cancelled` are set
 * only by the close action (D19: `cancelled` when nothing arrived, `closed` otherwise). */
export const PURCHASE_STATUSES = ["ordered", "partially_received", "received", "closed", "cancelled"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** What a purchase line buys — exactly one of fabric_id/accessory_id is set, agreeing with this. */
export const PURCHASE_ITEM_TYPES = ["fabric", "accessory"] as const;
export type PurchaseItemType = (typeof PURCHASE_ITEM_TYPES)[number];

/** One receipt table pair serves both purchases and production output (D2). */
export const GOODS_RECEIPT_SOURCE_TYPES = ["purchase", "production_batch"] as const;
export type GoodsReceiptSourceType = (typeof GOODS_RECEIPT_SOURCE_TYPES)[number];

/** A receipt is corrected only by a `reversal` receipt that negates it exactly (D8). */
export const GOODS_RECEIPT_KINDS = ["receipt", "reversal"] as const;
export type GoodsReceiptKind = (typeof GOODS_RECEIPT_KINDS)[number];

/** What a defect_movements row is about (docs/plans/suppliers-goods-receipt.md §3.5, migration
 * 0026): a finished-goods SKU (production output), a fabric or an accessory (purchase lines).
 * Exactly one of defect_movements.sku/fabric_id/accessory_id is set, agreeing with this. */
export const DEFECT_ITEM_KINDS = ["sku", "fabric", "accessory"] as const;
export type DefectItemKind = (typeof DEFECT_ITEM_KINDS)[number];

/** The defect ledger's vocabulary (§3.5). `reject` (S5): units that arrived defective at a goods
 * receipt, mirroring goods_receipt_items.qty_rejected 1:1. `return_out` (S6): defects sent back to
 * the supplier/tailor for exchange. `dispose` (S6): defects released, with a `disposal_type`.
 * `reversal`: the exact negation of one earlier row (D8). Created complete in 0026 so S6 needs no
 * CHECK migration; nothing writes `return_out`/`dispose` until S6. */
export const DEFECT_MOVEMENT_TYPES = ["reject", "return_out", "dispose", "reversal"] as const;
export type DefectMovementType = (typeof DEFECT_MOVEMENT_TYPES)[number];

/** How a defect is released (D24 + the owner's answer to N-new-1, recorded as D29): `auction`
 * (Lelang, proceeds > 0 entered by hand), `donation` (Hibah, Rp 0, a deliberate giveaway) and
 * `discarded` (Dibuang/Dimusnahkan, Rp 0, pure waste). Donation and discarded are both Rp 0 but are
 * always reported separately. Indonesian labels live in apps/admin, never in the DB. */
export const DEFECT_DISPOSAL_TYPES = ["auction", "donation", "discarded"] as const;
export type DefectDisposalType = (typeof DEFECT_DISPOSAL_TYPES)[number];

export const STOCK_MOVEMENT_TYPES = ["production", "sale", "return", "adjustment"] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

// "goods_receipt_item" (migration 0024, docs/plans/suppliers-goods-receipt.md §3.4): a
// 'production' movement that originates from a goods receipt of a production batch line — the
// only way finished goods enter stock from S4 (migration 0025) on. ref_id is the
// goods_receipt_items.id (the receipt's own item, or for a reversal's negative row, the reversal's
// item). "production_batch_item" rows are history: written at posting by releases before S4.
export const STOCK_MOVEMENT_REF_TYPES = ["production_batch_item", "order_item", "manual", "goods_receipt_item"] as const;
export type StockMovementRefType = (typeof STOCK_MOVEMENT_REF_TYPES)[number];

/** Only ever set when `type = 'adjustment'` — see stock_movements_reason_adjustment_pair_check
 * (migration 0006). */
export const STOCK_ADJUSTMENT_REASONS = ["recount", "damaged", "lost", "other"] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

export const PRODUCTION_BATCH_STATUSES = ["draft", "posted"] as const;
export type ProductionBatchStatus = (typeof PRODUCTION_BATCH_STATUSES)[number];

/** How much of a POSTED batch's output has been received into sellable stock
 * (docs/plans/suppliers-goods-receipt.md D5, migration 0025). Deliberately a separate column from
 * `status` (which keeps its exact draft/posted meaning, so the freeze trigger and the previous
 * release are untouched). A draft is always `pending`. `pending` → `partially_received` →
 * `received` is recomputed from the receipts after every receipt and reversal; `closed` is set
 * only by the short-close action ("Tutup batch", with a required reason). There is no
 * `cancelled`: a posted batch already consumed its material, so closing one is always a close. */
export const PRODUCTION_RECEIPT_STATUSES = ["pending", "partially_received", "received", "closed"] as const;
export type ProductionReceiptStatus = (typeof PRODUCTION_RECEIPT_STATUSES)[number];

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
 * a manual purchase/adjustment/void with no single natural source row.
 *
 * "goods_receipt" (migration 0024): the 'purchase' row a goods receipt writes for one accepted
 * purchase line, and the 'purchase_void' row its reversal writes. `ref_id` is the
 * goods_receipt_items.id of THAT line (the receipt's own item for the purchase row, the
 * reversal's item for the void row), so a per-line SUM of value_amount nets with no self-join. */
export const RAW_MATERIAL_MOVEMENT_REF_TYPES = ["production_batch", "manual", "goods_receipt"] as const;
export type RawMaterialMovementRefType = (typeof RAW_MATERIAL_MOVEMENT_REF_TYPES)[number];

/** "shopee"/"tiktok" are the two marketplace channels a future importer reconciles against —
 * `channel_order_no` is required for these (validated in app code, see lib/orders/queries.ts)
 * so a later import of the same order updates via the existing unique key instead of duplicating
 * it. "whatsapp"/"instagram"/"offline" are manual-entry-only channels (no external order number
 * ever exists for them); "web" is the Dec 2026 main-site checkout's channel. Staff can also
 * pick "web" for a manual order, so a CHECKOUT order is identified by
 * `orders.payment_status IS NOT NULL` (migration 0030), never by the channel alone. */
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

// ---------- Storefront checkout (docs/plans/cart-checkout.md §3, migration 0030) ----------

/** A web order line's stock hold (plan D3). `active` counts against storefront availability
 * only while `expires_at > now()`, so a missed sweep never strands stock; `consumed` at payment
 * (the real `sale` movement is written then), `released` on expiry or cancel. */
export const STOCK_RESERVATION_STATUSES = ["active", "consumed", "released"] as const;
export type StockReservationStatus = (typeof STOCK_RESERVATION_STATUSES)[number];

export const PAYMENT_PROVIDERS = ["midtrans"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** One payment ATTEMPT's state (payments.status, plan §6.2). `created` until the gateway answers
 * the create call; `failed` is an attempt-level outcome (the buyer may retry inside the gateway
 * page until expiry). No card-only states: cards are never enabled (plan D16). */
export const PAYMENT_STATUSES = [
  "created",
  "pending",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
  "chargeback",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** The ORDER's payment state (orders.payment_status), set only on checkout orders (NULL for
 * every other order, including staff-entered `web` orders). Deliberately not PAYMENT_STATUSES:
 * `created` and `failed` describe one attempt, never the order (owner decision, 2026-10-20). */
export const ORDER_PAYMENT_STATUSES = [
  "pending",
  "paid",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
  "chargeback",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

/** Why a checkout order was cancelled (orders.cancel_reason). NULL for orders cancelled before
 * migration 0030 and for every non-checkout cancel by the current admin. */
export const ORDER_CANCEL_REASONS = ["payment_expired", "payment_cancelled", "admin"] as const;
export type OrderCancelReason = (typeof ORDER_CANCEL_REASONS)[number];

/** Flags on orders.needs_attention (a set: several can hold at once; adding one never removes
 * another and clearing is per flag; owner decision, 2026-10-20). The admin "Perlu perhatian"
 * filter is `cardinality(needs_attention) > 0`. The full set ships now, Phase K's
 * `tracking_stale` / `delivery_problem` included, so no later migration has to replace the CHECK.
 * `payment_anomaly`: a card-only gateway status (`capture` / `authorize`) or a `credit_card`
 * payment type, which must never mark an order paid (plan §6.2). */
export const ORDER_ATTENTION_FLAGS = [
  "stock_short_at_payment",
  "paid_after_cancel",
  "amount_mismatch",
  "refund_due",
  "refund_received",
  "payment_anomaly",
  "tracking_stale",
  "delivery_problem",
] as const;
export type OrderAttentionFlag = (typeof ORDER_ATTENTION_FLAGS)[number];

/** Transactional emails (plan §8); order_notifications (order_id, kind) is UNIQUE, the
 * idempotency guard that keeps a retried webhook from sending twice. */
export const ORDER_NOTIFICATION_KINDS = ["created", "paid", "shipped", "delivered", "cancelled", "owner_paid"] as const;
export type OrderNotificationKind = (typeof ORDER_NOTIFICATION_KINDS)[number];

// ---------- Shipping quote (docs/plans/cart-checkout.md §4.5, migration 0031) ----------

/** Bounds of products.shipping_weight_grams (one packed piece: folded, in its own plastic). Back
 * the products_shipping_weight_grams_check CHECK and the admin form's validation. */
export const PRODUCT_SHIPPING_WEIGHT_MIN_GRAMS = 50;
export const PRODUCT_SHIPPING_WEIGHT_MAX_GRAMS = 30_000;

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
