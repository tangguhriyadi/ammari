import "server-only";
import { sql } from "drizzle-orm";
import type { TikTokApplyState, TikTokHeldReason, TikTokOrderReviewFlag } from "@ammari/db/schema";
import { TikTokMoneyFormatError, parseRupiah, type AllowlistedObject } from "@ammari/tiktok-shop";
import type { Database } from "../db";
import { tiktokSnapshotLines } from "./order-store";

// The T4 dry run (docs/plans/tiktok-shop-integration.md §10 T4: "Akan dibuat / ditahan"): what T5
// would do with each TikTok order, computed at read time from the projection and the SKU mappings.
// Nothing is written: no admin order, no stock, no `apply_state`. T5 replaces this with
// `decideTikTokOrder` (§4.2), which also checks stock and lines against an existing order; this
// preview only covers what T4 knows (status, SKU mapping, money format, a hand-typed match).

/** TikTok's nine order statuses (§0). Anything else is held as `unknown_status`, never guessed. */
export const TIKTOK_ORDER_STATUSES = [
  "UNPAID",
  "ON_HOLD",
  "AWAITING_SHIPMENT",
  "PARTIALLY_SHIPPING",
  "AWAITING_COLLECTION",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type TikTokPreviewOutcome =
  /** Not in admin yet; T5 would create it. */
  | { kind: "create"; reviewPartialShipping: boolean }
  /** A hand-typed admin order has the same TikTok number; T5 would match and update it. */
  | { kind: "update"; reviewPartialShipping: boolean }
  | { kind: "held"; reason: Extract<TikTokHeldReason, "unknown_sku" | "unknown_status" | "money_format">; detail?: string }
  /** UNPAID (not a sale yet), or CANCELLED before it ever reached admin. */
  | { kind: "skip"; reason: "unpaid" | "cancelled" };

export interface TikTokPreviewInput {
  status: string;
  payload: AllowlistedObject;
  /** TikTok SKU ids with an active mapping. */
  mappedSkuIds: ReadonlySet<string>;
  /** An admin order with channel `tiktok` and this TikTok order number exists. */
  inAdmin: boolean;
}

function isObject(value: unknown): value is AllowlistedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LINE_MONEY_FIELDS = ["original_price", "sale_price", "seller_discount", "platform_discount"] as const;

/** The first money field that is not whole rupiah (Q6), or a currency other than IDR. Absent
 * fields are not checked here (T5 decides what it needs). */
export function tiktokMoneyProblem(payload: AllowlistedObject): string | null {
  const check = (value: unknown, field: string) => {
    if (value === undefined || value === null || value === "") return null;
    try {
      parseRupiah(value, { field });
      return null;
    } catch (error) {
      if (error instanceof TikTokMoneyFormatError) return field;
      throw error;
    }
  };
  const payment = payload.payment;
  // T5 needs the order's amounts: no payment object is held, never read as zero.
  if (!isObject(payment)) return "payment";
  if (payment.currency !== undefined && payment.currency !== "IDR") return "payment.currency";
  for (const [key, value] of Object.entries(payment)) {
    if (key === "currency") continue;
    const problem = check(value, `payment.${key}`);
    if (problem) return problem;
  }
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.currency !== undefined && item.currency !== "IDR") return "line_items.currency";
    for (const field of LINE_MONEY_FIELDS) {
      const problem = check(item[field], `line_items.${field}`);
      if (problem) return problem;
    }
  }
  return null;
}

/** More than one package id across the order or its lines (Q2: manual review). */
function multiPackage(payload: AllowlistedObject): boolean {
  const ids = new Set<string>();
  for (const pkg of Array.isArray(payload.packages) ? payload.packages : []) if (isObject(pkg) && typeof pkg.id === "string") ids.add(pkg.id);
  for (const item of Array.isArray(payload.line_items) ? payload.line_items : []) if (isObject(item) && typeof item.package_id === "string") ids.add(item.package_id);
  return ids.size > 1;
}

/** Pure: what T5 would do with this order today. */
export function previewTikTokOrder(input: TikTokPreviewInput): TikTokPreviewOutcome {
  const { status, payload } = input;
  if (!(TIKTOK_ORDER_STATUSES as readonly string[]).includes(status)) return { kind: "held", reason: "unknown_status", detail: status };
  if (status === "UNPAID" && !input.inAdmin) return { kind: "skip", reason: "unpaid" };
  if (status === "CANCELLED" && !input.inAdmin) return { kind: "skip", reason: "cancelled" };
  const moneyProblem = tiktokMoneyProblem(payload);
  if (moneyProblem) return { kind: "held", reason: "money_format", detail: moneyProblem };
  const items = Array.isArray(payload.line_items) ? payload.line_items.filter(isObject) : [];
  const lines = tiktokSnapshotLines(payload);
  // A line without a SKU id can never be mapped.
  if (items.length === 0 || lines.length !== items.length) return { kind: "held", reason: "unknown_sku" };
  const unmapped = lines.filter((line) => !input.mappedSkuIds.has(line.skuId)).map((line) => line.skuId);
  if (unmapped.length > 0) return { kind: "held", reason: "unknown_sku", detail: [...new Set(unmapped)].join(", ") };
  const reviewPartialShipping = status === "PARTIALLY_SHIPPING" || multiPackage(payload);
  return input.inAdmin ? { kind: "update", reviewPartialShipping } : { kind: "create", reviewPartialShipping };
}

export interface TikTokOrderPreviewRow {
  tiktokOrderId: string;
  status: string;
  latestUpdateTime: Date;
  paidTime: Date | null;
  rtsSlaTime: Date | null;
  lineCount: number;
  hasBuyerMessage: boolean;
  reviewFlags: TikTokOrderReviewFlag[];
  outcome: TikTokPreviewOutcome;
  /** What T5 actually did (null while applying is off or the order was never tried). */
  applied: { state: TikTokApplyState; heldReason: TikTokHeldReason | null; orderId: string | null; orderNo: string | null } | null;
}

export interface TikTokOrderPreview {
  rows: TikTokOrderPreviewRow[];
  counts: { create: number; update: number; held: number; skip: number };
  /** All TikTok orders stored, not only the rows listed. */
  total: number;
}

export const TIKTOK_ORDER_PREVIEW_LIMIT = 100;

/** The most recently updated TikTok orders with their dry-run outcome. The counts cover the rows
 * listed. */
export async function listTikTokOrderPreviews(db: Database, limit = TIKTOK_ORDER_PREVIEW_LIMIT): Promise<TikTokOrderPreview> {
  const rows = await db.execute<{
    tiktok_order_id: string;
    status: string;
    latest_update_time: string | Date;
    paid_time: string | Date | null;
    rts_sla_time: string | Date | null;
    has_buyer_message: boolean;
    review_flags: TikTokOrderReviewFlag[];
    payload: AllowlistedObject;
    in_admin: boolean;
    apply_state: TikTokApplyState | null;
    held_reason: TikTokHeldReason | null;
    order_id: string | null;
    order_no: string | null;
  }>(sql`
    select o.tiktok_order_id, o.status, o.latest_update_time, o.paid_time, o.rts_sla_time,
           o.buyer_message is not null as has_buyer_message, o.review_flags, s.payload,
           exists (select 1 from orders a where a.channel_id = 'tiktok' and a.channel_order_no = o.tiktok_order_id) as in_admin,
           o.apply_state, o.held_reason, o.order_id, ao.order_no
    from tiktok_orders o
    join tiktok_order_snapshots s on s.id = o.latest_snapshot_id
    left join orders ao on ao.id = o.order_id
    order by o.latest_update_time desc, o.tiktok_order_id
    limit ${limit}
  `);
  const [{ total } = { total: 0 }] = await db.execute<{ total: number }>(sql`select count(*)::int as total from tiktok_orders`);
  const mapped = await db.execute<{ tiktok_sku_id: string }>(sql`select tiktok_sku_id from tiktok_sku_mappings where is_active`);
  const mappedSkuIds = new Set(mapped.map((row) => row.tiktok_sku_id));
  const counts = { create: 0, update: 0, held: 0, skip: 0 };
  const result = rows.map((row): TikTokOrderPreviewRow => {
    const outcome = previewTikTokOrder({ status: row.status, payload: row.payload, mappedSkuIds, inAdmin: row.in_admin });
    counts[outcome.kind] += 1;
    return {
      tiktokOrderId: row.tiktok_order_id,
      status: row.status,
      latestUpdateTime: new Date(row.latest_update_time),
      paidTime: row.paid_time ? new Date(row.paid_time) : null,
      rtsSlaTime: row.rts_sla_time ? new Date(row.rts_sla_time) : null,
      lineCount: Array.isArray(row.payload.line_items) ? row.payload.line_items.length : 0,
      hasBuyerMessage: row.has_buyer_message,
      reviewFlags: row.review_flags,
      outcome,
      applied: row.apply_state ? { state: row.apply_state, heldReason: row.held_reason, orderId: row.order_id, orderNo: row.order_no } : null,
    };
  });
  return { rows: result, counts, total: Number(total) };
}
