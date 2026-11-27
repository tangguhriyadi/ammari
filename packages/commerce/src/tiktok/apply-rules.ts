// Pure rules for applying a TikTok order to admin (docs/plans/tiktok-shop-integration.md §4.2-§4.4,
// T5): `decideTikTokOrder` (what to do with one snapshot against the admin order, if any) and the
// packing gate (`tiktokReadyToShip`, decided Q1). No database and no clock of their own: callers
// pass `now`. The commit (apply.ts) runs the decision in one transaction through createOrder's
// stock helper and transitionOrderStatus; nothing here writes.
//
// Rules, all from the plan's status table (§4.3), never guessed:
//   - forward only: an admin order never moves back; terminal stays terminal;
//   - stock leaves when TikTok first reports the order paid (the order is created at `to_ship`);
//   - it comes back only through a cancel before shipping (`to_ship → cancelled`). A cancel after
//     shipping (a failed delivery) sets flags only: the parcel must be received back first (Q11);
//   - one TikTok SKU = one Ammari variant (Q12). An unmapped SKU holds the order;
//   - money that is not whole rupiah holds the order (Q6), never rounded;
//   - an existing order's lines are never changed: a difference holds it (`lines_differ`).

import type { OrderAttentionFlag, OrderStatus, TikTokHeldReason, TikTokOrderReviewFlag } from "@ammari/db/schema";
import { TikTokMoneyFormatError, parseRupiah, type AllowlistedObject } from "@ammari/tiktok-shop";
import { TIKTOK_ORDER_STATUSES, tiktokMoneyProblem } from "./order-preview";

/** The buyer may cancel for one hour after paying (Q1). */
export const TIKTOK_PACKING_HOLD_MS = 60 * 60 * 1000;

export interface TikTokGateInput {
  status: string;
  isOnHoldOrder: boolean | null;
  paidTime: Date | null;
}

/** The packing gate, exactly as decided (Q1): `AWAITING_SHIPMENT` and (`is_on_hold_order` or 1 h
 * since `paid_time`). `is_on_hold_order = true` means the order already served its remorse window
 * during ON_HOLD, so fulfilment can begin at once (TikTok's Order Sync guide; confirmed by the owner
 * 27 Nov 2026). Which ON_HOLD flow Indonesia uses is still checked in T0. */
export function tiktokReadyToShip(order: TikTokGateInput, now: Date): boolean {
  if (order.status !== "AWAITING_SHIPMENT") return false;
  if (order.isOnHoldOrder === true) return true;
  return order.paidTime !== null && now.getTime() - order.paidTime.getTime() >= TIKTOK_PACKING_HOLD_MS;
}

export type TikTokPackingState =
  | { kind: "ready" }
  /** Not packable yet: the buyer can still cancel. `until` = paid_time + 1 h, when known. */
  | { kind: "wait"; until: Date | null }
  /** Multi-package / partial shipping: settled by hand (Q2). */
  | { kind: "review" }
  /** TikTok cancelled it (the sync moves the admin order unless applying is off or held). Never packed. */
  | { kind: "cancelled" };

/** What /packing shows for a `to_ship` TikTok order. `AWAITING_COLLECTION` (and anything later the
 * sync has not moved yet) is packable: the shipment is already arranged in Seller Center. */
export function tiktokPackingState(order: TikTokGateInput, now: Date): TikTokPackingState {
  if (order.status === "CANCELLED") return { kind: "cancelled" };
  if (order.status === "PARTIALLY_SHIPPING") return { kind: "review" };
  if (order.status === "ON_HOLD" || order.status === "UNPAID") return { kind: "wait", until: null };
  if (order.status === "AWAITING_SHIPMENT") {
    if (tiktokReadyToShip(order, now)) return { kind: "ready" };
    return { kind: "wait", until: order.paidTime ? new Date(order.paidTime.getTime() + TIKTOK_PACKING_HOLD_MS) : null };
  }
  return { kind: "ready" };
}

const JAKARTA_TIME = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "14.32" in Asia/Jakarta. */
export function formatJakartaTime(date: Date): string {
  const parts = JAKARTA_TIME.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}.${minute}`;
}

/** Why staff may not mark this TikTok order shipped yet, in Indonesian; null once packable. */
export function tiktokPackingRefusal(order: TikTokGateInput, now: Date): string | null {
  const state = tiktokPackingState(order, now);
  if (state.kind === "ready") return null;
  if (state.kind === "review") return "Pesanan TikTok ini dikirim dalam beberapa paket. Cek dan selesaikan dulu di Seller Center.";
  if (state.kind === "cancelled") return "Pesanan ini sudah dibatalkan di TikTok. Jangan dikirim; cek di Seller Center.";
  return state.until
    ? `Pesanan TikTok ini belum boleh dikemas: pembeli masih bisa membatalkan sampai ${formatJakartaTime(state.until)}.`
    : "Pesanan TikTok ini belum boleh dikemas: pembeli masih bisa membatalkan.";
}

export interface TikTokAdminLine {
  sku: string;
  qty: number;
}

/** The admin order as locked by the commit. */
export interface TikTokAdminOrderState {
  status: OrderStatus;
  lines: readonly TikTokAdminLine[];
  needsAttention: readonly OrderAttentionFlag[];
  marketplaceShippedAt: Date | null;
  marketplaceCompletedAt: Date | null;
  marketplaceReturnedAt: Date | null;
}

export interface DecideTikTokOrderInput {
  status: string;
  isOnHoldOrder: boolean | null;
  paidTime: Date | null;
  collectionTime: Date | null;
  cancelTime: Date | null;
  /** The snapshot's version. */
  updateTime: Date;
  /** The allowlisted snapshot payload. */
  payload: AllowlistedObject;
  /** Active mappings only: TikTok SKU id → Ammari variant SKU. */
  mappings: ReadonlyMap<string, string>;
  /** Null when no admin order has this TikTok number. */
  admin: TikTokAdminOrderState | null;
  now: Date;
}

export interface TikTokOrderLine {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface TikTokNewOrder {
  orderDate: Date;
  /** Sorted by SKU (the lock order). */
  lines: TikTokOrderLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
}

export interface TikTokEffects {
  addFlags: OrderAttentionFlag[];
  removeFlags: OrderAttentionFlag[];
  /** Written only while the column is NULL (write once). Null = nothing to write. */
  marketplaceShippedAt: Date | null;
  marketplaceCompletedAt: Date | null;
  marketplaceReturnedAt: Date | null;
  reviewFlags: TikTokOrderReviewFlag[];
}

export type TikTokDecision =
  | { kind: "skip"; reason: "unpaid" | "cancelled" }
  | { kind: "hold"; reason: TikTokHeldReason; detail: string | null }
  /** Create at `to_ship` (stock leaves), then run `transitions` in order. */
  | { kind: "create"; order: TikTokNewOrder; transitions: OrderStatus[]; effects: TikTokEffects }
  | { kind: "update"; transitions: OrderStatus[]; effects: TikTokEffects };

const PAID_OPEN_STATUSES = new Set(["ON_HOLD", "AWAITING_SHIPMENT", "PARTIALLY_SHIPPING", "AWAITING_COLLECTION"]);
const SHIPPED_STATUSES = new Set(["IN_TRANSIT", "DELIVERED", "COMPLETED"]);

/** The admin status a TikTok status leads to (CANCELLED and UNPAID are handled on their own). */
function targetStatus(status: string): OrderStatus | null {
  if (PAID_OPEN_STATUSES.has(status)) return "to_ship";
  if (status === "IN_TRANSIT" || status === "DELIVERED") return "shipped";
  if (status === "COMPLETED") return "completed";
  return null;
}

const FORWARD: readonly OrderStatus[] = ["awaiting_payment", "to_ship", "shipped", "completed"];

/** The steps from `from` to `to` along awaiting_payment → to_ship → shipped → completed; empty when
 * `to` is not ahead of `from` (forward only), or `from` is terminal. */
function forwardSteps(from: OrderStatus, to: OrderStatus): OrderStatus[] {
  const start = FORWARD.indexOf(from);
  const end = FORWARD.indexOf(to);
  if (start < 0 || end <= start) return [];
  return FORWARD.slice(start + 1, end + 1);
}

function isObject(value: unknown): value is AllowlistedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineItems(payload: AllowlistedObject): AllowlistedObject[] {
  return Array.isArray(payload.line_items) ? payload.line_items.filter(isObject) : [];
}

function skuIdOf(item: AllowlistedObject): string | null {
  const value = item.sku_id;
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** TikTok's 202309 order has one line item per piece; a `quantity`, when present, must be a
 * positive whole number (to be confirmed on real data in T0). */
function quantityOf(item: AllowlistedObject): number | null {
  if (item.quantity === undefined || item.quantity === null) return 1;
  return typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : null;
}

function multiPackage(payload: AllowlistedObject): boolean {
  const ids = new Set<string>();
  for (const pkg of Array.isArray(payload.packages) ? payload.packages : []) if (isObject(pkg) && typeof pkg.id === "string") ids.add(pkg.id);
  for (const item of lineItems(payload)) if (typeof item.package_id === "string") ids.add(item.package_id);
  return ids.size > 1;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type LinesResult = { ok: true; lines: { sku: string; qty: number }[] } | { ok: false; reason: TikTokHeldReason; detail: string | null };

/** Line items grouped per mapped variant (qty summed), sorted by SKU. */
function mappedLines(payload: AllowlistedObject, mappings: ReadonlyMap<string, string>): LinesResult {
  const items = lineItems(payload);
  if (items.length === 0) return { ok: false, reason: "unknown_sku", detail: null };
  const unmapped = new Set<string>();
  const qtyBySku = new Map<string, number>();
  for (const item of items) {
    const skuId = skuIdOf(item);
    if (!skuId) return { ok: false, reason: "unknown_sku", detail: null };
    const sku = mappings.get(skuId);
    if (!sku) {
      unmapped.add(skuId);
      continue;
    }
    const qty = quantityOf(item);
    if (qty === null) return { ok: false, reason: "line_format", detail: `quantity:${skuId}` };
    qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + qty);
  }
  if (unmapped.size > 0) return { ok: false, reason: "unknown_sku", detail: [...unmapped].sort(compareText).join(", ") };
  return { ok: true, lines: [...qtyBySku].map(([sku, qty]) => ({ sku, qty })).sort((a, b) => compareText(a.sku, b.sku)) };
}

type MoneyResult = { ok: true; order: TikTokNewOrder } | { ok: false; reason: TikTokHeldReason; detail: string | null };

function money(value: unknown, field: string): number | TikTokMoneyFormatError {
  try {
    return parseRupiah(value, { field });
  } catch (error) {
    if (error instanceof TikTokMoneyFormatError) return error;
    throw error;
  }
}

function secondsToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

/** Amounts per Q7: unit_price = the original (list) price per piece; discount = every
 * seller-funded discount (item discounts and seller vouchers, TikTok's `payment.seller_discount`);
 * platform discounts are TikTok's and ignored; no shipping (pass-through). */
function newOrder(input: DecideTikTokOrderInput, lines: { sku: string; qty: number }[]): MoneyResult {
  const problem = tiktokMoneyProblem(input.payload);
  if (problem) return { ok: false, reason: "money_format", detail: problem };
  const priceBySku = new Map<string, number>();
  let lineSellerDiscounts = 0;
  for (const item of lineItems(input.payload)) {
    const sku = input.mappings.get(skuIdOf(item) ?? "")!;
    const price = money(item.original_price, "line_items.original_price");
    if (price instanceof TikTokMoneyFormatError) return { ok: false, reason: "money_format", detail: "line_items.original_price" };
    const known = priceBySku.get(sku);
    if (known !== undefined && known !== price) return { ok: false, reason: "line_format", detail: `price:${sku}` };
    priceBySku.set(sku, price);
    if (item.seller_discount !== undefined && item.seller_discount !== null && item.seller_discount !== "") {
      const discount = money(item.seller_discount, "line_items.seller_discount");
      if (discount instanceof TikTokMoneyFormatError) return { ok: false, reason: "money_format", detail: "line_items.seller_discount" };
      lineSellerDiscounts += discount * (quantityOf(item) ?? 1);
    }
  }
  const payment = input.payload.payment as AllowlistedObject;
  const discountAmount = money(payment.seller_discount, "payment.seller_discount");
  // An absent seller discount is never read as zero.
  if (discountAmount instanceof TikTokMoneyFormatError) return { ok: false, reason: "money_format", detail: "payment.seller_discount" };
  // The order's seller discount includes every line's: fewer would mean TikTok's fields mean
  // something else than assumed.
  if (lineSellerDiscounts > discountAmount) return { ok: false, reason: "money_format", detail: "line_items.seller_discount" };
  const priced = lines.map((line) => ({ ...line, unitPrice: priceBySku.get(line.sku)! }));
  const subtotalAmount = priced.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const totalAmount = subtotalAmount - discountAmount;
  if (!Number.isSafeInteger(subtotalAmount) || totalAmount < 0) return { ok: false, reason: "money_format", detail: "payment.seller_discount" };
  const orderDate = secondsToDate(input.payload.create_time) ?? input.paidTime ?? input.updateTime;
  return { ok: true, order: { orderDate, lines: priced, subtotalAmount, discountAmount, totalAmount } };
}

function sameGoods(admin: readonly TikTokAdminLine[], tiktok: readonly { sku: string; qty: number }[]): boolean {
  if (admin.length !== tiktok.length) return false;
  const bySku = new Map(admin.map((line) => [line.sku, line.qty]));
  return tiktok.every((line) => bySku.get(line.sku) === line.qty);
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a !== null && b !== null && a.getTime() === b.getTime();
}

/** Flags and write-once dates for the order once `finalStatus` is reached. */
function effectsFor(input: DecideTikTokOrderInput, finalStatus: OrderStatus): TikTokEffects {
  const admin = input.admin;
  const effects: TikTokEffects = { addFlags: [], removeFlags: [], marketplaceShippedAt: null, marketplaceCompletedAt: null, marketplaceReturnedAt: null, reviewFlags: [] };

  if (finalStatus === "to_ship" && tiktokPackingState(input, input.now).kind === "wait") effects.addFlags.push("tiktok_on_hold");
  else effects.removeFlags.push("tiktok_on_hold");

  if (input.status === "PARTIALLY_SHIPPING" || multiPackage(input.payload)) {
    effects.addFlags.push("marketplace_review");
    effects.reviewFlags.push("tiktok_partial_shipping");
  }

  if (SHIPPED_STATUSES.has(input.status) && input.collectionTime && (finalStatus === "shipped" || finalStatus === "completed" || finalStatus === "returned")) {
    const written = admin?.marketplaceShippedAt ?? null;
    if (written === null) effects.marketplaceShippedAt = input.collectionTime;
    else if (!sameTime(written, input.collectionTime)) effects.reviewFlags.push("tiktok_ship_time_changed");
  }
  if (input.status === "COMPLETED" && finalStatus === "completed" && !admin?.marketplaceCompletedAt) effects.marketplaceCompletedAt = input.updateTime;
  return effects;
}

export function decideTikTokOrder(input: DecideTikTokOrderInput): TikTokDecision {
  const { status, admin } = input;
  if (!(TIKTOK_ORDER_STATUSES as readonly string[]).includes(status)) return { kind: "hold", reason: "unknown_status", detail: status.slice(0, 64) };

  if (!admin) {
    if (status === "UNPAID") return { kind: "skip", reason: "unpaid" };
    if (status === "CANCELLED") return { kind: "skip", reason: "cancelled" };
    const lines = mappedLines(input.payload, input.mappings);
    if (!lines.ok) return { kind: "hold", reason: lines.reason, detail: lines.detail };
    const order = newOrder(input, lines.lines);
    if (!order.ok) return { kind: "hold", reason: order.reason, detail: order.detail };
    const target = targetStatus(status);
    // Every listed status but UNPAID/CANCELLED (handled above) has a target; a new one is never guessed.
    if (target === null) return { kind: "hold", reason: "unknown_status", detail: status.slice(0, 64) };
    const transitions = forwardSteps("to_ship", target);
    return { kind: "create", order: order.order, transitions, effects: effectsFor(input, transitions.at(-1) ?? "to_ship") };
  }

  // Terminal stays terminal. A cancelled admin order that TikTok still sells is a person's call:
  // its stock was already given back.
  if (admin.status === "returned") return { kind: "update", transitions: [], effects: { ...effectsFor(input, "returned"), addFlags: [], reviewFlags: [] } };
  if (admin.status === "cancelled") {
    if (status === "CANCELLED" || status === "UNPAID") return { kind: "update", transitions: [], effects: { ...effectsFor(input, "cancelled"), addFlags: [], reviewFlags: [] } };
    return { kind: "hold", reason: "final_in_admin", detail: status };
  }

  if (status === "UNPAID") return { kind: "update", transitions: [], effects: { ...effectsFor(input, admin.status), addFlags: [], reviewFlags: [] } };

  if (status === "CANCELLED") {
    // A collection time means the courier took the parcel, even when admin never saw IN_TRANSIT (a
    // missed or held version): never a stock return then. Flags only, and a person checks why admin
    // still says Siap Kirim.
    if (admin.status === "to_ship" && input.collectionTime !== null) {
      return {
        kind: "update",
        transitions: [],
        effects: {
          ...effectsFor(input, "shipped"),
          addFlags: ["marketplace_return_pending", "marketplace_return_in_transit", "marketplace_review"],
          marketplaceShippedAt: null,
          marketplaceReturnedAt: admin.marketplaceReturnedAt ? null : input.cancelTime,
          reviewFlags: [],
        },
      };
    }
    if (admin.status === "awaiting_payment" || admin.status === "to_ship") {
      return { kind: "update", transitions: ["cancelled"], effects: { ...effectsFor(input, "cancelled"), addFlags: [], reviewFlags: [] } };
    }
    // After shipping (a failed delivery, Q11): no status change, no stock. The return waits for
    // the parcel ("Retur diterima", T6).
    const effects = effectsFor(input, admin.status);
    return {
      kind: "update",
      transitions: [],
      effects: {
        ...effects,
        addFlags: ["marketplace_return_pending", "marketplace_return_in_transit"],
        marketplaceReturnedAt: admin.marketplaceReturnedAt ? null : input.cancelTime,
        reviewFlags: [],
      },
    };
  }

  const lines = mappedLines(input.payload, input.mappings);
  if (!lines.ok) return { kind: "hold", reason: lines.reason, detail: lines.detail };
  if (!sameGoods(admin.lines, lines.lines)) return { kind: "hold", reason: "lines_differ", detail: null };

  // PARTIALLY_SHIPPING moves nothing past to_ship (Q2).
  const target = targetStatus(status);
  if (target === null) return { kind: "hold", reason: "unknown_status", detail: status.slice(0, 64) };
  const transitions = forwardSteps(admin.status, target);
  return { kind: "update", transitions, effects: effectsFor(input, transitions.at(-1) ?? admin.status) };
}
