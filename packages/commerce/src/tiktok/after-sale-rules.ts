// Pure rules for TikTok cancellations and returns (docs/plans/tiktok-shop-integration.md §4.5, T6).
// No database and no clock of their own: callers pass `now`. The commit (after-sale.ts) runs the
// decision in one transaction; nothing here writes.
//
// Decided in §12.1 and followed exactly, never guessed:
//   - read only towards TikTok (Q15): a request waiting for the seller is listed with its deadline
//     ("respond in Seller Center"), nothing is answered from here;
//   - refund-only (Q10): money back, goods stay with the buyer → one marketplace_refunds row at
//     RETURN_OR_REFUND_REQUEST_COMPLETE; status, stock and HPP untouched;
//   - return with goods (Q10 D-7, Q18) and failed delivery (Q11): stock comes back only when the
//     parcel is physically received ("Retur diterima"); until then pending + in transit;
//   - some items only, with goods: marketplace_partial_return, settled by hand;
//   - anything else (replacement, an unknown type or status, lines that cannot be matched, money
//     that is not whole rupiah, a refund above the order total): a person decides (state `review`).
//
// TikTok's status and type names are those of the 202309 return_refund API; T0 checks them against
// real requests. A name not listed here is `review`, so a misnamed one is never silently handled.

import type { OrderAttentionFlag, OrderStatus, TikTokAfterSaleKind, TikTokAfterSaleReviewReason, TikTokAfterSaleState } from "@ammari/db/schema";
import { TikTokMoneyFormatError, parseRupiah, type AllowlistedObject } from "@ammari/tiktok-shop";

/** Sellers must respond within 48 h, or TikTok approves automatically (§0 "Returns"). */
export const TIKTOK_RESPONSE_WINDOW_MS = 48 * 60 * 60 * 1000;

type StatusClass = "open" | "approved" | "goods_coming" | "complete" | "closed" | "package_rejected";

const RETURN_STATUSES: Readonly<Record<string, StatusClass>> = {
  RETURN_OR_REFUND_REQUEST_PENDING: "open",
  AWAITING_BUYER_RESPONSE: "open",
  AWAITING_BUYER_SHIP: "approved",
  RETURN_OR_REFUND_REQUEST_SUCCESS: "approved",
  BUYER_SHIPPED_ITEM: "goods_coming",
  RETURN_OR_REFUND_REQUEST_COMPLETE: "complete",
  REFUND_OR_RETURN_REQUEST_REJECT: "closed",
  RETURN_OR_REFUND_REQUEST_CANCEL: "closed",
  REJECT_RECEIVE_PACKAGE: "package_rejected",
};

const CANCELLATION_STATUSES: Readonly<Record<string, StatusClass>> = {
  CANCELLATION_REQUEST_PENDING: "open",
  CANCELLATION_REQUEST_SUCCESS: "complete",
  CANCELLATION_REQUEST_COMPLETE: "complete",
  CANCELLATION_REQUEST_CANCEL: "closed",
};

/** The status of a request that waits for the seller's first answer: due 48 h after it was made
 * when TikTok names no deadline of its own. */
const PENDING_REQUEST_STATUSES = new Set(["RETURN_OR_REFUND_REQUEST_PENDING", "CANCELLATION_REQUEST_PENDING"]);

const REFUND_ONLY = "REFUND";
const RETURN_WITH_GOODS = "RETURN_AND_REFUND";
const REPLACEMENT = "REPLACEMENT";

function statusClass(kind: TikTokAfterSaleKind, status: string): StatusClass | null {
  const table = kind === "return" ? RETURN_STATUSES : CANCELLATION_STATUSES;
  return Object.hasOwn(table, status) ? table[status]! : null;
}

/** Statuses after which nothing waits for anyone. */
export function tiktokAfterSaleIsFinal(kind: TikTokAfterSaleKind, status: string): boolean {
  const cls = statusClass(kind, status);
  return cls === "complete" || cls === "closed";
}

function isObject(value: unknown): value is AllowlistedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secondsToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

/** When the seller must answer in Seller Center: TikTok's earliest `seller_next_action_response`
 * deadline, else (a request still pending its first answer) `create_time` + 48 h. Null when nothing
 * waits for the seller, or when no deadline can be known (never invented). Stored at ingest, so the
 * list works while applying is off. */
export function tiktokAfterSaleResponseDue(record: { kind: TikTokAfterSaleKind; status: string; createTime: Date | null; payload: AllowlistedObject }): Date | null {
  if (tiktokAfterSaleIsFinal(record.kind, record.status)) return null;
  const actions = Array.isArray(record.payload.seller_next_action_response) ? record.payload.seller_next_action_response.filter(isObject) : [];
  const deadlines = actions.map((action) => secondsToDate(action.deadline)).filter((date): date is Date => date !== null);
  if (deadlines.length > 0) return new Date(Math.min(...deadlines.map((date) => date.getTime())));
  if (PENDING_REQUEST_STATUSES.has(record.status) && record.createTime) return new Date(record.createTime.getTime() + TIKTOK_RESPONSE_WINDOW_MS);
  return null;
}

export interface AfterSaleDecideInput {
  kind: TikTokAfterSaleKind;
  status: string;
  requestType: string | null;
  /** The version being applied. */
  updateTime: Date;
  /** The first COMPLETE version's `update_time`, when one was stored before (written once). */
  completedAt: Date | null;
  payload: AllowlistedObject;
  /** What the previous applied version made of this request. */
  previousState: TikTokAfterSaleState | null;
  /** The TikTok order's line item ids (its latest order snapshot); null when unknown. */
  orderLineIds: readonly string[] | null;
  /** The admin order, locked; null when the order is not in admin. */
  admin: { status: OrderStatus; totalAmount: number } | null;
  /** The sync skipped the TikTok order (unpaid, or cancelled before admin ever saw it). */
  orderSkipped: boolean;
}

export interface AfterSaleDecision {
  state: TikTokAfterSaleState;
  reviewReason: TikTokAfterSaleReviewReason | null;
  /** Refund-only, complete: the marketplace_refunds amount (whole rupiah, > 0). */
  refundAmount: number | null;
  /** Return with goods, complete: `orders.marketplace_returned_at` (written once). */
  returnedAt: Date | null;
}

function decision(state: TikTokAfterSaleState, extra: Partial<AfterSaleDecision> = {}): AfterSaleDecision {
  return { state, reviewReason: null, refundAmount: null, returnedAt: null, ...extra };
}

function review(reason: TikTokAfterSaleReviewReason): AfterSaleDecision {
  return decision("review", { reviewReason: reason });
}

type Coverage = "full" | "partial" | "unknown";

/** Whether a return with goods takes back every line of the order (TikTok lists one line item per
 * piece, matched by `order_line_item_id`). Anything that cannot be matched is `unknown`. */
function coverage(payload: AllowlistedObject, orderLineIds: readonly string[] | null): Coverage {
  if (!orderLineIds || orderLineIds.length === 0) return "unknown";
  const lines = Array.isArray(payload.return_line_items) ? payload.return_line_items : [];
  if (lines.length === 0) return "unknown";
  const order = new Set(orderLineIds);
  const returned = new Set<string>();
  for (const line of lines) {
    if (!isObject(line) || typeof line.order_line_item_id !== "string" || !order.has(line.order_line_item_id)) return "unknown";
    returned.add(line.order_line_item_id);
  }
  return returned.size === order.size ? "full" : "partial";
}

function refundTotal(payload: AllowlistedObject): number | null {
  const money = isObject(payload.refund_amount) ? payload.refund_amount : {};
  try {
    const amount = parseRupiah(money.refund_total, { field: "refund_amount.refund_total" });
    return amount > 0 ? amount : null;
  } catch (error) {
    if (error instanceof TikTokMoneyFormatError) return null;
    throw error;
  }
}

const NOT_SHIPPED: readonly OrderStatus[] = ["awaiting_payment", "to_ship", "cancelled"];

export function decideTikTokAfterSale(input: AfterSaleDecideInput): AfterSaleDecision {
  const cls = statusClass(input.kind, input.status);
  if (cls === null) return review("unknown_status");
  if (!input.admin) return input.orderSkipped ? decision("closed") : decision("waiting_order");

  if (input.kind === "cancellation") {
    if (cls === "open") return decision("open");
    if (cls === "complete") return decision("cancel_completed");
    return decision("closed");
  }

  if (cls === "closed") {
    // The goods were on their way back: the parcel may still arrive. A person decides.
    if (input.previousState === "goods_coming" || input.previousState === "completed_goods") return review("closed_after_goods");
    // A refund already recorded, then TikTok reports the request closed: a contradiction a person
    // checks (the refund row stays; it is append-only).
    if (input.previousState === "completed_refund") return review("unknown_status");
    return decision("closed");
  }
  if (cls === "package_rejected") return review("package_rejected");
  if (input.requestType === REPLACEMENT) return review("replacement");
  if (input.requestType !== REFUND_ONLY && input.requestType !== RETURN_WITH_GOODS) return review("unknown_type");
  if (NOT_SHIPPED.includes(input.admin.status)) return review("before_shipping");

  if (input.requestType === REFUND_ONLY) {
    if (cls === "goods_coming") return review("unknown_status");
    if (cls !== "complete") return decision(cls);
    if (input.admin.status === "returned") return review("after_return");
    const amount = refundTotal(input.payload);
    if (amount === null) return review("money_format");
    if (amount > input.admin.totalAmount) return review("refund_over_total");
    return decision("completed_refund", { refundAmount: amount });
  }

  const covered = coverage(input.payload, input.orderLineIds);
  if (covered === "unknown") return review("lines_unknown");
  if (covered === "partial") return decision("partial");
  if (cls === "complete") return decision("completed_goods", { returnedAt: input.completedAt ?? input.updateTime });
  return decision(cls);
}

// ---- Order flags from every request of one order ----------------------------------------------

const RETURN_PENDING_STATES: ReadonlySet<TikTokAfterSaleState> = new Set(["open", "approved", "goods_coming", "completed_goods"]);
const GOODS_STATES: ReadonlySet<TikTokAfterSaleState> = new Set(["goods_coming", "completed_goods"]);
const WAITING_STATES: ReadonlySet<TikTokAfterSaleState> = new Set(["open", "approved", "goods_coming", "partial", "review"]);

export interface AfterSaleFlagsInput {
  /** Every applied request of the order (state set, not `waiting_order`). */
  rows: readonly { kind: TikTokAfterSaleKind; state: TikTokAfterSaleState; responseDueAt: Date | null }[];
  /** The request this apply changed (its state before and after), or null for a re-check. */
  changed: { kind: TikTokAfterSaleKind; from: TikTokAfterSaleState | null; to: TikTokAfterSaleState } | null;
  adminStatus: OrderStatus;
  /** The TikTok order's own status (projection). */
  tiktokStatus: string | null;
  now: Date;
}

/** The order flags T6 sets and clears:
 *   - `tiktok_return_response_due`: fully derived (a request still waiting, deadline ahead);
 *   - `marketplace_return_pending` / `_in_transit`: added when a request enters a state that needs
 *     them (never re-added on a re-check, so a person's "Hapus tanda retur" sticks); pending is
 *     removed once no return of the order needs it, except while TikTok reports the order CANCELLED
 *     (a failed delivery, T5's Q11 path owns it then). In transit is never removed here: it ends with
 *     "Retur diterima" (Q11, Q18);
 *   - `marketplace_partial_return` / `marketplace_review`: added once, when a request enters them.
 * An order already returned or cancelled in admin gets no return flag. */
export function tiktokAfterSaleFlags(input: AfterSaleFlagsInput): { add: OrderAttentionFlag[]; remove: OrderAttentionFlag[] } {
  const add: OrderAttentionFlag[] = [];
  const remove: OrderAttentionFlag[] = [];
  const ended = input.adminStatus === "returned" || input.adminStatus === "cancelled";
  const entered = input.changed && input.changed.from !== input.changed.to ? input.changed : null;

  if (entered && !ended && entered.kind === "return") {
    if (RETURN_PENDING_STATES.has(entered.to)) add.push("marketplace_return_pending");
    if (GOODS_STATES.has(entered.to)) add.push("marketplace_return_in_transit");
    if (entered.to === "partial") add.push("marketplace_partial_return");
  }
  if (entered && entered.to === "review") add.push("marketplace_review");

  const due = input.rows.some((row) => WAITING_STATES.has(row.state) && row.responseDueAt !== null && row.responseDueAt.getTime() > input.now.getTime());
  if (due) add.push("tiktok_return_response_due");
  else remove.push("tiktok_return_response_due");

  const returns = input.rows.filter((row) => row.kind === "return");
  if (returns.length > 0 && !returns.some((row) => RETURN_PENDING_STATES.has(row.state)) && input.tiktokStatus !== "CANCELLED" && !add.includes("marketplace_return_pending")) {
    remove.push("marketplace_return_pending");
  }
  return { add, remove };
}
