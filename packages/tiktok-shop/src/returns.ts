import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyAllowlist, type AllowlistSpec, type AllowlistedObject } from "./allowlist";
import { TikTokApiError, type TikTokClient } from "./client";
import { SEARCH_AFTER_SALES_MAX_ORDER_IDS, SEARCH_AFTER_SALES_MAX_PAGE_SIZE, TIKTOK_ENDPOINTS } from "./endpoints";
import { canonicalJson, isTikTokOrderId, storable, tiktokSeconds } from "./orders";
import type { Secret } from "./secret";

// Cancellations and returns towards TikTok (docs/plans/tiktok-shop-integration.md §0 "Returns", §4.5,
// §6; T6). READ ONLY (decided Q15): Search Returns and Search Cancellations, by `update_time` window
// (the reconciliation poll) or by order ids (a topic 11/12 trigger). No approve, reject or any other
// write call exists here: responses stay in Seller Center.
//
// A raw record never leaves this module: each is allowlisted and versioned by its `update_time`.
// Field names follow TikTok's 202309 return_refund objects and are checked against a real response
// on the development shop (T0), like the order fields (§9.1): a field TikTok names differently is
// simply absent, and the rules (commerce/tiktok/after-sale-rules.ts) then flag the request for a
// person rather than guess.

export type TikTokAfterSaleKind = "return" | "cancellation";

const MONEY: AllowlistSpec = {
  currency: true,
  refund_total: true,
  refund_subtotal: true,
  refund_shipping_fee: true,
  refund_tax: true,
  retail_delivery_fee: true,
};

const NEXT_ACTION: AllowlistSpec = { action: true, deadline: true };

/** Plan §6. Ids, statuses, times, deadlines, amounts and line ids only. The buyer's free text
 * (`return_reason_text`), contact and anything TikTok adds later never reach the database. */
export const TIKTOK_RETURN_ALLOWLIST: AllowlistSpec = {
  return_id: true,
  order_id: true,
  return_type: true,
  return_status: true,
  arbitration_status: true,
  role: true,
  create_time: true,
  update_time: true,
  return_reason: true,
  return_method: true,
  shipment_type: true,
  handover_method: true,
  return_provider_name: true,
  return_tracking_number: true,
  is_combined_return: true,
  combined_return_id: true,
  seller_next_action_response: [NEXT_ACTION],
  refund_amount: MONEY,
  return_line_items: [
    {
      return_line_item_id: true,
      order_line_item_id: true,
      sku_id: true,
      seller_sku: true,
      product_name: true,
      sku_name: true,
      refund_amount: MONEY,
    },
  ],
};

export const TIKTOK_CANCELLATION_ALLOWLIST: AllowlistSpec = {
  cancel_id: true,
  order_id: true,
  cancel_type: true,
  cancel_status: true,
  role: true,
  create_time: true,
  update_time: true,
  cancel_reason: true,
  seller_next_action_response: [NEXT_ACTION],
  refund_amount: MONEY,
  cancel_line_items: [
    {
      cancel_line_item_id: true,
      order_line_item_id: true,
      sku_id: true,
      seller_sku: true,
      product_name: true,
      sku_name: true,
      refund_amount: MONEY,
    },
  ],
};

const FIELDS = {
  return: { id: "return_id", status: "return_status", type: "return_type", allowlist: TIKTOK_RETURN_ALLOWLIST, listKey: "return_orders", path: TIKTOK_ENDPOINTS.searchReturns },
  cancellation: { id: "cancel_id", status: "cancel_status", type: "cancel_type", allowlist: TIKTOK_CANCELLATION_ALLOWLIST, listKey: "cancellations", path: TIKTOK_ENDPOINTS.searchCancellations },
} as const;

const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const CODE_PATTERN = /^[A-Z_]{1,64}$/;

function secondsToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

export interface TikTokAfterSaleProjection {
  kind: TikTokAfterSaleKind;
  /** `return_id` or `cancel_id`. */
  requestId: string;
  tiktokOrderId: string;
  /** `return_status` / `cancel_status`, raw. */
  status: string;
  /** `return_type` / `cancel_type`, raw; null when absent or not a code. */
  requestType: string | null;
  createTime: Date | null;
  /** The version. */
  updateTime: Date;
  payload: AllowlistedObject;
  contentSha256: string;
}

export type ProjectTikTokAfterSaleResult = { ok: true; record: TikTokAfterSaleProjection } | { ok: false; reason: "invalid_record"; requestId: string | null };

/** One raw return or cancellation → its projection. Pure. */
export function projectTikTokAfterSale(kind: TikTokAfterSaleKind, raw: unknown): ProjectTikTokAfterSaleResult {
  const fields = FIELDS[kind];
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawId = record[fields.id];
  const requestId = typeof rawId === "string" && ID_PATTERN.test(rawId) ? rawId : null;
  const orderId = isTikTokOrderId(record.order_id) ? record.order_id : null;
  const status = typeof record[fields.status] === "string" && CODE_PATTERN.test(record[fields.status] as string) ? (record[fields.status] as string) : null;
  const updateTime = secondsToDate(record.update_time);
  if (!requestId || !orderId || !status || !updateTime) return { ok: false, reason: "invalid_record", requestId };
  const rawType = record[fields.type];
  const payload = storable(applyAllowlist(record, fields.allowlist)) as AllowlistedObject;
  return {
    ok: true,
    record: {
      kind,
      requestId,
      tiktokOrderId: orderId,
      status,
      requestType: typeof rawType === "string" && CODE_PATTERN.test(rawType) ? rawType : null,
      createTime: secondsToDate(record.create_time),
      updateTime,
      payload,
      contentSha256: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
    },
  };
}

interface ShopCall {
  accessToken: Secret;
  shopCipher: string;
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

export type SearchTikTokAfterSalesInput = ShopCall & { pageToken?: string | null; pageSize?: number } & ({ updateTimeGe: Date; updateTimeLt: Date; orderIds?: undefined } | { orderIds: readonly string[]; updateTimeGe?: undefined; updateTimeLt?: undefined });

export interface SearchTikTokAfterSalesPage {
  records: TikTokAfterSaleProjection[];
  /** Entries that cannot be versioned (the caller holds its cursor on them). */
  invalid: number;
  /** Ids of the invalid entries, when they had one. */
  invalidIds: string[];
  nextPageToken: string | null;
}

const pageSchemas = {
  return: z.object({ return_orders: z.array(z.unknown()).max(SEARCH_AFTER_SALES_MAX_PAGE_SIZE).optional(), next_page_token: z.string().max(4096).optional() }),
  cancellation: z.object({ cancellations: z.array(z.unknown()).max(SEARCH_AFTER_SALES_MAX_PAGE_SIZE).optional(), next_page_token: z.string().max(4096).optional() }),
};
// `.passthrough()`: the other keys are kept only to spot a list under another name (above).
const passthrough = { return: pageSchemas.return.passthrough(), cancellation: pageSchemas.cancellation.passthrough() };

/** One page of Search Returns or Search Cancellations, sorted by `update_time` ascending. Either
 * a window (both bounds always sent, §0) or up to 20 order ids. */
export async function searchTikTokAfterSales(client: TikTokClient, kind: TikTokAfterSaleKind, input: SearchTikTokAfterSalesInput): Promise<SearchTikTokAfterSalesPage> {
  let body: Record<string, unknown>;
  if (input.orderIds !== undefined) {
    if (input.orderIds.length === 0 || input.orderIds.length > SEARCH_AFTER_SALES_MAX_ORDER_IDS) throw new Error(`searchTikTokAfterSales: 1-${SEARCH_AFTER_SALES_MAX_ORDER_IDS} order ids`);
    if (!input.orderIds.every(isTikTokOrderId)) throw new Error("searchTikTokAfterSales: invalid order id");
    body = { order_ids: [...input.orderIds] };
  } else {
    const ge = tiktokSeconds(input.updateTimeGe);
    const lt = tiktokSeconds(input.updateTimeLt);
    if (!(ge < lt)) throw new Error("searchTikTokAfterSales: update_time_ge must be before update_time_lt");
    body = { update_time_ge: ge, update_time_lt: lt };
  }
  const pageSize = input.pageSize ?? SEARCH_AFTER_SALES_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SEARCH_AFTER_SALES_MAX_PAGE_SIZE) throw new Error("searchTikTokAfterSales: page_size must be 1-50");
  const fields = FIELDS[kind];
  const data = (await client.request({
    method: "POST",
    path: fields.path,
    query: { page_size: pageSize, sort_field: "update_time", sort_order: "ASC", ...(input.pageToken ? { page_token: input.pageToken } : {}) },
    body,
    accessToken: input.accessToken,
    shopCipher: input.shopCipher,
    schema: passthrough[kind] as z.ZodType<Record<string, unknown>>,
    deadline: input.deadline,
    onAuthError: input.onAuthError,
  })) as { next_page_token?: string } & Record<string, unknown>;
  // An answer without the list but with another list under a different name means TikTok's field is
  // not the one assumed (T0 checks it): refused loudly, never read as "no requests", which would let
  // the cursor pass every request of the window.
  if (data[fields.listKey] === undefined && Object.values(data).some(Array.isArray)) {
    throw new TikTokApiError({ kind: "invalid_response", path: fields.path, httpStatus: null, code: null, requestId: null });
  }
  const list = (data[fields.listKey] as unknown[] | undefined) ?? [];
  const page: SearchTikTokAfterSalesPage = { records: [], invalid: 0, invalidIds: [], nextPageToken: null };
  for (const raw of list) {
    const projected = projectTikTokAfterSale(kind, raw);
    if (projected.ok) page.records.push(projected.record);
    else {
      page.invalid += 1;
      if (projected.requestId) page.invalidIds.push(projected.requestId);
    }
  }
  const token = data.next_page_token?.trim() ?? "";
  page.nextPageToken = token === "" ? null : token;
  return page;
}
