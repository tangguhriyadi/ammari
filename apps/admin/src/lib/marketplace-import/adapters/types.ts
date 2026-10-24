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
  | (ColumnSpecBase & { field: "channelOrderNo" | "status" | "orderedAt" | "sku" | "qty" | "lineTotal"; required: true })
  | (ColumnSpecBase & { field: "sellerVoucher"; required: boolean; scope: ColumnScope })
  | (ColumnSpecBase & { field: "fee"; component: ChannelFeeComponent; required: false; scope: ColumnScope })
  // Display-only hints next to an unknown SKU; never stored, never used to match (owner addition A).
  | (ColumnSpecBase & { field: "productName" | "variationName"; required: false });

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
}
