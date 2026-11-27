import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyAllowlist, type AllowlistSpec, type AllowlistedObject, type AllowlistedValue } from "./allowlist";
import type { TikTokClient } from "./client";
import { ORDER_DETAIL_MAX_IDS, SEARCH_ORDERS_MAX_PAGE_SIZE, TIKTOK_ENDPOINTS } from "./endpoints";
import type { Secret } from "./secret";

// The order read side towards TikTok (docs/plans/tiktok-shop-integration.md §0 "Orders", §4.1, §6;
// T4): Search Orders by `update_time` window, Get Order Detail in batches of at most 50, and the
// order allowlist. A raw order never leaves this module: `getTikTokOrderDetails` returns each order
// already projected (allowlisted payload + the few typed fields the projection row needs + the
// buyer message, which goes only to `tiktok_orders.buyer_message`, decided Q14).
//
// Field names follow TikTok's 202309 order object. They are to be checked against a real response
// on the development shop (T0); a field TikTok names differently is simply absent (dropped, never
// guessed), and the dry-run page shows what that breaks before T5 applies anything.

/** Plan §6 "kept for orders". No recipient, address, phone, email, `user_id`, `buyer_email`,
 * `buyer_message` or `seller_note`: they are not on the list, so they never reach the database,
 * including any field TikTok adds later. */
export const TIKTOK_ORDER_ALLOWLIST: AllowlistSpec = {
  id: true,
  status: true,
  create_time: true,
  paid_time: true,
  update_time: true,
  collection_time: true,
  delivery_time: true,
  cancel_time: true,
  rts_sla_time: true,
  tts_sla_time: true,
  rts_time: true,
  is_on_hold_order: true,
  cancel_reason: true,
  cancellation_initiator: true,
  fulfillment_type: true,
  delivery_option_id: true,
  delivery_option_name: true,
  delivery_type: true,
  shipping_type: true,
  shipping_provider: true,
  shipping_provider_id: true,
  tracking_number: true,
  split_or_combine_tag: true,
  payment: {
    currency: true,
    sub_total: true,
    shipping_fee: true,
    seller_discount: true,
    platform_discount: true,
    total_amount: true,
    original_total_product_price: true,
    original_shipping_fee: true,
    shipping_fee_seller_discount: true,
    shipping_fee_platform_discount: true,
    shipping_fee_cofunded_discount: true,
    tax: true,
    product_tax: true,
    shipping_fee_tax: true,
  },
  line_items: [
    {
      id: true,
      sku_id: true,
      product_id: true,
      seller_sku: true,
      product_name: true,
      sku_name: true,
      quantity: true,
      currency: true,
      original_price: true,
      sale_price: true,
      seller_discount: true,
      platform_discount: true,
      display_status: true,
      package_id: true,
      package_status: true,
      shipping_provider_name: true,
      tracking_number: true,
      is_gift: true,
      cancel_reason: true,
    },
  ],
  packages: [{ id: true }],
};

const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const STATUS_PATTERN = /^[A-Z_]{1,64}$/;
/** `tiktok_orders.buyer_message` holds at most this many characters (CHECK in 0058). */
export const TIKTOK_BUYER_MESSAGE_MAX_CHARS = 1_000;

/** An id Get Order Detail can take (a comma would split the `ids` list). */
export function isTikTokOrderId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && !value.includes(",");
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** What Postgres jsonb refuses in a string (NUL, a lone surrogate) is removed or replaced, so one
 * odd product name can never make an order unstorable. Numbers that are not safe integers become
 * strings of their own spelling: jsonb would otherwise write 1e300 out in full. */
function storable(value: AllowlistedValue): AllowlistedValue {
  if (typeof value === "string") return value.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\uFFFD");
  if (typeof value === "number") return Number.isSafeInteger(value) || (Number.isFinite(value) && Math.abs(value) < 1e15) ? value : String(value);
  if (Array.isArray(value)) return value.map((item) => storable(item as AllowlistedValue)) as AllowlistedValue;
  if (value !== null && typeof value === "object") {
    const result: AllowlistedObject = {};
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, { value: storable(item), enumerable: true, writable: true, configurable: true });
    return result;
  }
  return value;
}

/** Every object's keys sorted, arrays in order: the same content always hashes the same. */
export function canonicalJson(value: AllowlistedValue | AllowlistedObject): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item as AllowlistedValue)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as AllowlistedObject)[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** TikTok times are Unix seconds. Anything else (absent, 0, negative, a string, a fraction) is
 * null, never a guessed date. */
function secondsToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

/** The buyer's note, trimmed and capped (Q14). Empty → null. Cut by code point, never mid-character. */
function buyerMessageOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // NUL is refused by Postgres text; drop it rather than lose the note.
  const text = value.replaceAll("\u0000", "").trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length <= TIKTOK_BUYER_MESSAGE_MAX_CHARS ? text : chars.slice(0, TIKTOK_BUYER_MESSAGE_MAX_CHARS).join("");
}

export interface TikTokOrderProjection {
  tiktokOrderId: string;
  status: string;
  updateTime: Date;
  paidTime: Date | null;
  collectionTime: Date | null;
  deliveryTime: Date | null;
  cancelTime: Date | null;
  rtsSlaTime: Date | null;
  isOnHoldOrder: boolean | null;
  /** Only for `tiktok_orders.buyer_message`. Never in `payload`, never logged. */
  buyerMessage: string | null;
  /** The allowlisted order: the snapshot payload. */
  payload: AllowlistedObject;
  /** SHA-256 hex of `canonicalJson(payload)`. */
  contentSha256: string;
}

export type ProjectTikTokOrderResult =
  | { ok: true; order: TikTokOrderProjection }
  /** No usable id, status or `update_time`: cannot be versioned. Carries the id when it had one. */
  | { ok: false; reason: "invalid_order"; tiktokOrderId: string | null };

/** One raw order from Get Order Detail → its projection. Pure. */
export function projectTikTokOrder(raw: unknown): ProjectTikTokOrderResult {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const id = typeof record.id === "string" && ID_PATTERN.test(record.id) ? record.id : null;
  const status = typeof record.status === "string" && STATUS_PATTERN.test(record.status) ? record.status : null;
  const updateTime = secondsToDate(record.update_time);
  if (!id || !isTikTokOrderId(id) || !status || !updateTime) return { ok: false, reason: "invalid_order", tiktokOrderId: id };
  const payload = storable(applyAllowlist(record, TIKTOK_ORDER_ALLOWLIST)) as AllowlistedObject;
  return {
    ok: true,
    order: {
      tiktokOrderId: id,
      status,
      updateTime,
      paidTime: secondsToDate(record.paid_time),
      collectionTime: secondsToDate(record.collection_time),
      deliveryTime: secondsToDate(record.delivery_time),
      cancelTime: secondsToDate(record.cancel_time),
      rtsSlaTime: secondsToDate(record.rts_sla_time),
      isOnHoldOrder: typeof record.is_on_hold_order === "boolean" ? record.is_on_hold_order : null,
      buyerMessage: buyerMessageOf(record.buyer_message),
      payload,
      contentSha256: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
    },
  };
}

interface ShopCall {
  accessToken: Secret;
  shopCipher: string;
  /** Epoch ms: the run's time budget (plan §8.2). */
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

// Search keeps only the id of each order: the detail call is the one source of order content. An
// entry without a usable id is counted (`invalidIds`), never allowed to fail the whole page.
const searchSchema = z.object({
  orders: z.array(z.unknown()).max(SEARCH_ORDERS_MAX_PAGE_SIZE).optional(),
  next_page_token: z.string().max(4096).optional(),
});

export interface SearchTikTokOrdersInput extends ShopCall {
  /** Inclusive. */
  updateTimeGe: Date;
  /** Exclusive. Both bounds are always sent (§0). */
  updateTimeLt: Date;
  pageToken?: string | null;
  pageSize?: number;
}

export interface SearchTikTokOrdersPage {
  orderIds: string[];
  /** Entries without a usable id (the caller holds its cursor on them). */
  invalidIds: number;
  /** Null on the last page. */
  nextPageToken: string | null;
}

/** Unix seconds, rounded down for both bounds, so contiguous windows stay contiguous. */
export function tiktokSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** One page of Search Orders, sorted by `update_time` ascending, both bounds set. `page_token` is
 * signed raw and percent-encoded in the URL by the client. */
export async function searchTikTokOrders(client: TikTokClient, input: SearchTikTokOrdersInput): Promise<SearchTikTokOrdersPage> {
  const ge = tiktokSeconds(input.updateTimeGe);
  const lt = tiktokSeconds(input.updateTimeLt);
  if (!(ge < lt)) throw new Error("searchTikTokOrders: update_time_ge must be before update_time_lt");
  const pageSize = input.pageSize ?? SEARCH_ORDERS_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SEARCH_ORDERS_MAX_PAGE_SIZE) throw new Error("searchTikTokOrders: page_size must be 1-100");
  const data = await client.request({
    method: "POST",
    path: TIKTOK_ENDPOINTS.searchOrders,
    query: {
      page_size: pageSize,
      sort_field: "update_time",
      sort_order: "ASC",
      ...(input.pageToken ? { page_token: input.pageToken } : {}),
    },
    body: { update_time_ge: ge, update_time_lt: lt },
    accessToken: input.accessToken,
    shopCipher: input.shopCipher,
    schema: searchSchema,
    deadline: input.deadline,
    onAuthError: input.onAuthError,
  });
  const token = data.next_page_token?.trim() ?? "";
  const orderIds: string[] = [];
  let invalidIds = 0;
  for (const order of data.orders ?? []) {
    const id = typeof order === "object" && order !== null ? (order as { id?: unknown }).id : undefined;
    if (isTikTokOrderId(id)) orderIds.push(id);
    else invalidIds += 1;
  }
  return { orderIds, invalidIds, nextPageToken: token === "" ? null : token };
}

const detailSchema = z.object({ orders: z.array(z.unknown()).max(ORDER_DETAIL_MAX_IDS).optional() });

export interface TikTokOrderDetailsResult {
  orders: TikTokOrderProjection[];
  /** Orders TikTok returned that cannot be versioned (no id/status/update_time). */
  invalid: (string | null)[];
}

/** Get Order Detail for at most 50 ids. Every order is projected before it is returned; ids TikTok
 * did not return are simply absent (the caller compares). */
export async function getTikTokOrderDetails(client: TikTokClient, ids: readonly string[], call: ShopCall): Promise<TikTokOrderDetailsResult> {
  if (ids.length === 0) return { orders: [], invalid: [] };
  if (ids.length > ORDER_DETAIL_MAX_IDS) throw new Error(`getTikTokOrderDetails: at most ${ORDER_DETAIL_MAX_IDS} ids per call`);
  if (!ids.every(isTikTokOrderId)) throw new Error("getTikTokOrderDetails: invalid order id");
  const data = await client.request({
    method: "GET",
    path: TIKTOK_ENDPOINTS.orderDetail,
    query: { ids: ids.join(",") },
    accessToken: call.accessToken,
    shopCipher: call.shopCipher,
    schema: detailSchema,
    deadline: call.deadline,
    onAuthError: call.onAuthError,
  });
  const result: TikTokOrderDetailsResult = { orders: [], invalid: [] };
  for (const raw of data.orders ?? []) {
    const projected = projectTikTokOrder(raw);
    if (projected.ok) result.orders.push(projected.order);
    else result.invalid.push(projected.tiktokOrderId);
  }
  return result;
}
