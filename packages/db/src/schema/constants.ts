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
  // Migration 0034 (Phase K2): the booked courier price is more than Rp5.000 above the locked quote
  // (decision 47), and a resi typed by staff differs from the booked waybill (owner 2026-10-22).
  "shipping_cost_over_quote",
  "tracking_number_mismatch",
  // Migration 0040 (docs/plans/marketplace-import.md §3, owner decision 3): the marketplace says the
  // buyer is returning the parcel ("Dalam Pengembalian"). No stock effect until the return is final;
  // cleared when the order becomes cancelled/returned.
  "marketplace_return_pending",
] as const;
export type OrderAttentionFlag = (typeof ORDER_ATTENTION_FLAGS)[number];

// ---------- Courier booking (docs/plans/cart-checkout.md §3 "Phase K migrations", migration 0034) ----------

export const SHIPMENT_PROVIDERS = ["biteship"] as const;
export type ShipmentProviderName = (typeof SHIPMENT_PROVIDERS)[number];

/** One booking attempt's state (shipments.status). `booking`: the attempt is reserved and the
 * provider's answer is not known yet (or was lost); `failed`: the provider clearly refused, nothing
 * was booked. The rest are the normalized tracking states (SHIPMENT_TRACKING_STATUSES in
 * @ammari/commerce/shipment-rules, kept equal by a test). `cancelled` and `failed` end an attempt;
 * every other status is "live", and at most one live attempt exists per order. */
export const SHIPMENT_STATUSES = [
  "booking",
  "failed",
  "pickup_requested",
  "picked_up",
  "in_transit",
  "delivered",
  "cancelled",
  "returning",
  "returned",
  "problem",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** The normalized tracking states a courier history entry can carry (shipment_events.normalized_status,
 * migration 0035): every shipment status except our own booking states. */
export const SHIPMENT_TRACKING_STATES = SHIPMENT_STATUSES.filter((status) => status !== "booking" && status !== "failed");

/** Where a tracking event was read (migration 0035, K3): the webhook's re-fetch, the cron poller, or
 * a read staff triggered (booking, "Cek ulang", label print). */
export const SHIPMENT_EVENT_SOURCES = ["webhook", "poll", "staff"] as const;
export type ShipmentEventSource = (typeof SHIPMENT_EVENT_SOURCES)[number];

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

/** What one marketplace import did to one order (import_batch_orders.action, migration 0040). An
 * unchanged order gets no row (docs/plans/marketplace-import.md §6). */
export const IMPORT_BATCH_ORDER_ACTIONS = ["created", "updated"] as const;
export type ImportBatchOrderAction = (typeof IMPORT_BATCH_ORDER_ACTIONS)[number];

/** What a platform charges the seller on one order (order_channel_fees.component, migration 0040,
 * docs/plans/marketplace-import.md §5). A closed list behind a CHECK: a new platform's component
 * ships as a CHECK widen (owner decision 7). `seller_shipping_subsidy` is ongkir the seller pays on
 * the marketplace; it counts as a platform cost in "Laba setelah biaya platform" (plan §9). */
export const CHANNEL_FEE_COMPONENTS = [
  "admin_fee",
  "service_fee",
  "platform_commission",
  "affiliate_commission",
  "seller_shipping_subsidy",
  "other",
] as const;
export type ChannelFeeComponent = (typeof CHANNEL_FEE_COMPONENTS)[number];

/** Backs only the CHECK of the never-used `expenses` table (migration 0000). Not the "Iklan &
 * Biaya" categories: those are expense_categories rows (migration 0048). Kept until a contract migration
 * drops that table (docs/plans/growth.md Q2, awaiting owner confirmation). */
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

/** What a private (never public) stored file is for (docs/plans/purchase-payments.md §4.1). Each
 * table that points at private_files pins its own purpose through a composite FK, so a nota can
 * never be filed as a payment proof or the other way round. */
/** `journal_attachment` (migration 0052, docs/plans/accounting.md §5): the optional attachment of a
 * manual or opening journal (bank statement, platform screenshot). */
export const PRIVATE_FILE_PURPOSES = ["payment_proof", "purchase_invoice", "expense_proof", "journal_attachment"] as const;
export type PrivateFilePurpose = (typeof PRIVATE_FILE_PURPOSES)[number];

/** The only stored formats (§6): photos are re-encoded to JPEG, PDFs stored as-is. */
export const PRIVATE_FILE_CONTENT_TYPES = ["image/jpeg", "application/pdf"] as const;
export type PrivateFileContentType = (typeof PRIVATE_FILE_CONTENT_TYPES)[number];

/** What a supplier payment settles (§4.2): a purchase document or a posted production batch. */
export const SUPPLIER_PAYMENT_TARGET_TYPES = ["purchase", "production_batch"] as const;
export type SupplierPaymentTargetType = (typeof SUPPLIER_PAYMENT_TARGET_TYPES)[number];

/** Tunai / Transfer. Indonesian labels live in apps/admin, never in the DB. */
export const SUPPLIER_PAYMENT_METHODS = ["cash", "transfer"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

/** Kinds of file attached to a purchase document (§4.3). Only the supplier's invoice/nota today. */
export const PURCHASE_ATTACHMENT_KINDS = ["invoice"] as const;
export type PurchaseAttachmentKind = (typeof PURCHASE_ATTACHMENT_KINDS)[number];

// ---------- Iklan & Biaya (docs/plans/growth.md §3, migration 0042) ----------

/** The ten category codes that existed before migration 0048, in their original order. Since
 * 0048 (plan session S2) these are NOT the list of categories: `expense_categories` is, and the
 * app reads codes, names, kinds and fixed channels from it (apps/admin lib/expense-categories).
 * Kept as the typed seed set (DEFAULT_EXPENSE_CATEGORIES) and for the migration tests. "other"
 * (Lainnya) requires a note (business_expenses_other_note_check). */
export const BUSINESS_EXPENSE_CATEGORIES = [
  "ads_meta",
  "ads_tiktok",
  "ads_shopee",
  "endorsement",
  "material_shipping",
  "packaging",
  "salary",
  "rent",
  "utilities",
  "other",
] as const;
export type DefaultExpenseCategoryCode = (typeof BUSINESS_EXPENSE_CATEGORIES)[number];

/** An expense_categories.code. Owner-created categories have codes generated from their name, so
 * this is any string; the FK on business_expenses.category is what keeps it real. */
export type BusinessExpenseCategory = string;

/** The pre-0048 kind = 'ad' codes. Reference only (migration tests): ROAS reads `kind`. */
export const AD_EXPENSE_CATEGORIES = ["ads_meta", "ads_tiktok", "ads_shopee"] as const satisfies readonly DefaultExpenseCategoryCode[];

/** The pre-0048 marketing codes (kind 'ad' or 'endorsement'). Reference only: the app reads `kind`. */
export const MARKETING_EXPENSE_CATEGORIES = [...AD_EXPENSE_CATEGORIES, "endorsement"] as const satisfies readonly DefaultExpenseCategoryCode[];

/** The seeded fixed-channel rule (expense_categories.fixed_channel_id). Reference only: the app and
 * the business_expense_channel_rule trigger read the column. */
export const FIXED_EXPENSE_CHANNELS = { ads_shopee: "shopee", ads_tiktok: "tiktok" } as const satisfies Partial<Record<DefaultExpenseCategoryCode, ChannelId>>;

/** The category codes app logic names by literal. "other" (Lainnya) needs a note
 * (business_expenses_other_note_check); the rest are system rows the seed pins (kind, fixed
 * channel). Every one is is_system in DEFAULT_EXPENSE_CATEGORIES. */
export const SYSTEM_EXPENSE_CATEGORY_CODES = ["ads_meta", "ads_tiktok", "ads_shopee", "endorsement", "other"] as const satisfies readonly DefaultExpenseCategoryCode[];
export type SystemExpenseCategoryCode = (typeof SYSTEM_EXPENSE_CATEGORY_CODES)[number];

// ---------- Kategori Biaya master data (docs/plans/expense-master-data.md, migration 0048) ----------
// Since 0048 the categories live in `expense_categories` (owner-managed under Data Master), and
// the three CHECKs that listed the codes above are gone: an FK, the business_expense_channel_rule
// trigger and the sales_goal monthly-bill trigger replace them. Since S2 the app reads the catalog;
// the constants above are the typed seed set.

/** What a category does in the figures. ad: biaya iklan, counted in ROAS, channel optional or
 * fixed. endorsement: marketing, optional channel, never in ROAS. operating: no channel. Fixed per
 * category at creation (prevent_expense_category_identity_change). */
export const EXPENSE_CATEGORY_KINDS = ["ad", "endorsement", "operating"] as const;
export type ExpenseCategoryKind = (typeof EXPENSE_CATEGORY_KINDS)[number];

/** "Pengeluaran produksi" (plan §3.9, §3.11) shows supplier payments under this DISPLAY label; it
 * is never a real category, so no category may take its code or name (CHECKs in 0048). */
export const RESERVED_EXPENSE_CATEGORY_CODE = "biaya_produksi";
export const RESERVED_EXPENSE_CATEGORY_NAME = "Biaya produksi";

export interface DefaultExpenseCategory {
  code: DefaultExpenseCategoryCode;
  name: string;
  kind: ExpenseCategoryKind;
  fixedChannelId: ChannelId | null;
  isSystem: boolean;
  sortOrder: number;
}

/** The ten categories that existed before 0048, with today's labels. Inserted by migration 0048
 * (ON CONFLICT DO NOTHING) and, insert-only, by seed.ts; migration-0048.test.ts asserts the two
 * agree. System = the app logic matches the code (ROAS, fixed channels, "Lainnya" needs a note):
 * never deactivated, code/kind/fixed channel never change. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { code: "ads_meta", name: "Iklan Meta", kind: "ad", fixedChannelId: null, isSystem: true, sortOrder: 10 },
  { code: "ads_tiktok", name: "Iklan TikTok", kind: "ad", fixedChannelId: "tiktok", isSystem: true, sortOrder: 20 },
  { code: "ads_shopee", name: "Iklan Shopee", kind: "ad", fixedChannelId: "shopee", isSystem: true, sortOrder: 30 },
  { code: "endorsement", name: "Endorse/KOL", kind: "endorsement", fixedChannelId: null, isSystem: true, sortOrder: 40 },
  { code: "material_shipping", name: "Ongkir bahan", kind: "operating", fixedChannelId: null, isSystem: false, sortOrder: 110 },
  { code: "packaging", name: "Packaging", kind: "operating", fixedChannelId: null, isSystem: false, sortOrder: 120 },
  { code: "salary", name: "Gaji", kind: "operating", fixedChannelId: null, isSystem: false, sortOrder: 130 },
  { code: "rent", name: "Sewa", kind: "operating", fixedChannelId: null, isSystem: false, sortOrder: 140 },
  { code: "utilities", name: "Utilitas", kind: "operating", fixedChannelId: null, isSystem: false, sortOrder: 150 },
  { code: "other", name: "Lainnya", kind: "operating", fixedChannelId: null, isSystem: true, sortOrder: 990 },
] as const satisfies readonly DefaultExpenseCategory[];

/** Tunai, Transfer, Kartu (debit/kredit, e.g. Meta billing), Saldo platform (Saldo Penjual
 * Shopee/TikTok). Labels live in apps/admin. */
export const BUSINESS_EXPENSE_METHODS = ["cash", "transfer", "card", "platform_balance"] as const;
export type BusinessExpenseMethod = (typeof BUSINESS_EXPENSE_METHODS)[number];

/** voucher_adjustments.kind (plan §9.3): an owner void or extension, always with a reason. */
export const VOUCHER_ADJUSTMENT_KINDS = ["void", "extend"] as const;
export type VoucherAdjustmentKind = (typeof VOUCHER_ADJUSTMENT_KINDS)[number];

// ---------- Akuntansi: buku besar berpasangan (docs/plans/accounting.md §2.1, migration 0049) ----------
// The ledger is derived: a posting service (packages/accounting, later sessions) reads existing
// source records and writes journals into these tables only. Indonesian labels live in apps/admin.

/** accounts.type. contra_revenue (Potongan/Retur penjualan) is shown under revenue; cogs = HPP. */
export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "contra_revenue",
  "cogs",
  "expense",
  "other_income",
  "other_expense",
  "tax",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** An account code's leading digit is its class (plan §3: 1 ASET ... 9 PAJAK) and fixes the types
 * it may have, so a "6-xxxx" asset can't exist (Session 3, plan §8.1). accounts_code_type_check
 * (migration 0051) is generated from this map. */
export const ACCOUNT_CODE_CLASS_TYPES = {
  "1": ["asset"],
  "2": ["liability"],
  "3": ["equity"],
  "4": ["revenue", "contra_revenue"],
  "5": ["cogs"],
  "6": ["expense"],
  "7": ["other_income"],
  "8": ["other_expense"],
  "9": ["tax"],
} as const satisfies Record<string, readonly AccountType[]>;

/** Kas & Bank accounts (D-17): the codes under 1-1100 Kas and 1-1200 Bank. Only they carry bank
 * fields (accounts_bank_fields_cash_bank_check, migration 0051) and only they are payment-method
 * targets. Postgres regex syntax, also valid in JavaScript. */
export const CASH_BANK_ACCOUNT_CODE_PATTERN = "^1-1[12][0-9]{2}$";

/** Inventory accounts (1-15xx). An expense category or item is never mapped to one: raw materials
 * reach inventory only through goods receipts (plan §3 guard, D-14). */
export const INVENTORY_ACCOUNT_CODE_PATTERN = "^1-15[0-9]{2}$";

export const ACCOUNT_NORMAL_BALANCES = ["debit", "credit"] as const;
export type AccountNormalBalance = (typeof ACCOUNT_NORMAL_BALANCES)[number];

/** How the direct-method Arus kas classifies a line by its counter-account (plan §6). `cash`
 * marks the cash, bank and platform-balance accounts themselves; `none` is never classified. */
export const CASH_FLOW_GROUPS = ["operating", "investing", "financing", "cash", "none"] as const;
export type CashFlowGroup = (typeof CASH_FLOW_GROUPS)[number];

/** The account types the purchase-side guard refuses (plan §3 guard, §4.8, D-14): an expense,
 * HPP, other expense or tax account. Revenue types are not "expense" and are not listed. */
export const EXPENSE_LIKE_ACCOUNT_TYPES = ["cogs", "expense", "other_expense", "tax"] as const satisfies readonly AccountType[];

export const JOURNAL_ENTRY_KINDS = ["system", "manual", "opening", "reversal", "closing", "depreciation"] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export const FISCAL_PERIOD_STATUSES = ["open", "closed"] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

/** December 2026 is the trial month (D-22): the engine posts it, and it is never closed. */
export const ACCOUNTING_TRIAL_MONTH = "2026-12-01";

/** The official books start here (D-22); opening balances are as of the day before. The one
 * active opening journal is dated exactly this day (journal_entries_opening_date_check, 0052). */
export const ACCOUNTING_CUTOVER_DATE = "2027-01-01";

/** The last day of the trial month (D-22). */
export const ACCOUNTING_TRIAL_MONTH_END = "2026-12-31";

/** How a manual order (WhatsApp, Instagram, offline, manual web) was paid (D-3, migration 0053).
 * "card" is a debit card (D-18). No credit option: a manual order is always paid before it ships. */
export const MANUAL_ORDER_PAYMENT_METHODS = ["cash", "transfer", "card"] as const;
export type ManualOrderPaymentMethod = (typeof MANUAL_ORDER_PAYMENT_METHODS)[number];

export const POSTING_RUN_TRIGGERS = ["cron", "manual"] as const;
export type PostingRunTrigger = (typeof POSTING_RUN_TRIGGERS)[number];

export const POSTING_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type PostingRunStatus = (typeof POSTING_RUN_STATUSES)[number];

export const TAXPAYER_TYPES = ["individual", "company"] as const;
export type TaxpayerType = (typeof TAXPAYER_TYPES)[number];

/** Purchase-side journal sources (plan §4.4/§4.5 rules P1-P6, R1, R4): every line of a journal
 * with one of these (source_type, source_event) pairs must be on a balance-sheet account, never
 * on an EXPENSE_LIKE_ACCOUNT_TYPES account (D-14: fabric and accessory purchases are always
 * inventory; supplier payments only clear utang or build an advance). `event: null` = every event
 * of that source type. The journal_line_purchase_guard trigger (migration 0049) holds the same
 * list; migration-0049.test.ts proves each pair is refused. Not listed on purpose: raw-material
 * adjustments (P7, 6-4101/6-4102), the batch WIP close (R3, 5-1201/6-4102) and defect disposal
 * (A2, 6-4103), which post to those named expense accounts by decided policy (D-7, D-15, D-16). */
export const PURCHASE_SIDE_JOURNAL_SOURCES = [
  { sourceType: "goods_receipt_item", event: null },
  { sourceType: "supplier_payment", event: null },
  { sourceType: "purchase", event: null },
  { sourceType: "production_batch", event: "posted" },
  { sourceType: "defect_movement", event: "return_out" },
] as const satisfies readonly { sourceType: string; event: string | null }[];
