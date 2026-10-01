// Single source of truth for every "status/type" column's allowed values. Each array backs a
// database CHECK constraint (see the table definitions) AND is importable by application code —
// never duplicate these lists elsewhere.

export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

export const PRODUCT_CLOSURES = ["front_zip", "back_zip"] as const;
export type ProductClosure = (typeof PRODUCT_CLOSURES)[number];

export const STOCK_MOVEMENT_TYPES = ["production", "sale", "return", "adjustment"] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_MOVEMENT_REF_TYPES = ["production_batch_item", "order_item", "manual"] as const;
export type StockMovementRefType = (typeof STOCK_MOVEMENT_REF_TYPES)[number];

export const CHANNEL_IDS = ["shopee", "tiktok", "web", "reseller"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

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

export const OTP_PURPOSES = ["staff_login", "customer_login", "voucher_claim"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const THANK_YOU_CARD_STATUSES = ["active", "claimed", "void"] as const;
export type ThankYouCardStatus = (typeof THANK_YOU_CARD_STATUSES)[number];

export const VOUCHER_STATUSES = ["active", "used", "expired", "void"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

/**
 * The fixed cutting ratio per fabric roll (docs/SPEC.md §6): XS2-S4-M4-L3-XL2. A business
 * constant, not stored per fabric — used by the Overview dashboard to flag size-mix gaps
 * greater than 10 percentage points from this ratio.
 */
export const CUTTING_RATIO: Record<Size, number> = {
  XS: 2,
  S: 4,
  M: 4,
  L: 3,
  XL: 2,
};
