import type { ChannelFeeComponent, OrderStatus } from "@ammari/db/schema";

// One adapter per marketplace (docs/plans/marketplace-import.md §2). An adapter is data only: which
// header names mean what, the scope of each value, the status vocabulary. Adding TikTok later is a
// mapping plus tests, no new parsing code.

// What a platform charges the seller, per order (plan §5): the closed list behind
// order_channel_fees_component_check lives with the schema (migration 0040).
export { CHANNEL_FEE_COMPONENTS, type ChannelFeeComponent } from "@ammari/db/schema";
export type FeeAmounts = Partial<Record<ChannelFeeComponent, number>>;

/** `order`: the same value repeated on each row of an order, taken once (blanks ignored, two
 * different values are a problem). `line`: one value per row, summed. The double-count rule, plan §4. */
export type ColumnScope = "order" | "line";

interface ColumnSpecBase {
  /** The column's name as the owner sees it in Seller Center; used in every message. */
  label: string;
  /** Header texts that mean this column, as written in exports (normalized when matched). */
  aliases: readonly string[];
}

export type ColumnSpec =
  // Harga Awal: the revenue basis per piece (owner Q3); the row's goods amount is Harga Awal x Jumlah.
  | (ColumnSpecBase & { field: "channelOrderNo" | "status" | "orderedAt" | "sku" | "qty" | "listUnitPrice"; required: true })
  // Per-row values read only for the price check (plan §19.2), the returned-goods hold, or display
  // (Subtotal Pesanan, whose scope is unverified, O1-b). Never written.
  | (ColumnSpecBase & { field: "unitPriceAfterDiscount" | "totalDiscount" | "shopeeProductDiscount" | "returnedQty" | "fileSubtotal"; required: boolean })
  // Seller-funded money: every one of these is added to the order's discount_amount (D-4).
  | (ColumnSpecBase & { field: "sellerVoucher" | "sellerProductDiscount" | "sellerBundleDiscount"; required: boolean; scope: ColumnScope })
  // Status Pembatalan/ Pengembalian: order-level text; any non-blank value holds the order (§19.4).
  | (ColumnSpecBase & { field: "cancelReturnStatus"; required: boolean })
  // Waktu Pengiriman Diatur / Waktu Pesanan Selesai: order-level Jakarta times (§19.3). Stored in
  // orders.marketplace_shipped_at / _completed_at by the planner's status gate, write once.
  | (ColumnSpecBase & { field: "shippedAt" | "completedAt"; required: boolean })
  // Platform fees read from an order file. Shopee's order export has none (plan §19.2): its fees come
  // only from the Penghasilan Saya import (sessions 7d/7e). Kept for an adapter that does.
  | (ColumnSpecBase & { field: "fee"; component: ChannelFeeComponent; required: false; scope: ColumnScope })
  // Display-only hints next to an unknown SKU; never stored, never used to match (owner addition A).
  | (ColumnSpecBase & { field: "productName" | "variationName"; required: false });

export type SellerDiscountField = "sellerVoucher" | "sellerProductDiscount" | "sellerBundleDiscount";

export function columnSpecId(spec: ColumnSpec): string {
  return spec.field === "fee" ? `fee:${spec.component}` : spec.field;
}

/** What a marketplace status means for the admin order (plan §3). */
export type StatusRule =
  | { kind: "unpaid" }
  | { kind: "status"; status: Extract<OrderStatus, "to_ship" | "shipped" | "completed" | "cancelled" | "returned"> }
  | { kind: "return_pending" };

export interface StatusMapEntry {
  rule: StatusRule;
  /** Seen by the owner in a real export (plan §3). The others are Seller Center tab names whose
   * exact spelling in the export is unverified. Documentation only; both kinds map. */
  seenInRealFile: boolean;
}

export interface MarketplaceAdapter {
  channelId: "shopee" | "tiktok";
  label: string;
  /** null: the export's columns are not known yet; the file is refused before reading rows. */
  columns: readonly ColumnSpec[] | null;
  /** false: Periksa file works, Simpan is refused (plan §2.1, owner decision 14). */
  mappingVerified: boolean;
  /** Keyed by the normalized status text (`normalizeHeader`). */
  statusMap: Readonly<Record<string, StatusMapEntry>>;
  /** Shown instead of parsing when `columns` is null. */
  notReadyMessage?: string;
  /** Shown in the preview, and by the server on Simpan, while `mappingVerified` is false. */
  lockedMessage?: string;
  /** The exact header row of the verified export, in order. Any difference (a column renamed, added,
   * removed or moved) keeps the preview but blocks Simpan, so a silent format change can never
   * write (plan §19.2). null: no signature. */
  headerSignature: { headers: readonly string[]; since: string } | null;
}
