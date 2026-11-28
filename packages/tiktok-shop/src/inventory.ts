import "server-only";
import { z } from "zod";
import type { TikTokClient } from "./client";
import { TIKTOK_ENDPOINTS, UPDATE_INVENTORY_MAX_SKUS } from "./endpoints";
import type { Secret } from "./secret";

// Update Inventory (docs/plans/tiktok-stock-sync.md §0, §7; S2): THE ONLY CALL IN THIS PACKAGE THAT
// WRITES TO TIKTOK. Scope `seller.product.write` (Product Modify). One call per product; each SKU names
// exactly one warehouse, Ammari's own (never an FBT one: the caller only passes the warehouse the
// listing read classified as Ammari's), in INCREMENTAL mode, so TikTok never unlinks a warehouse.
//
// Quantities are absolute, so a retry of the same body (the client retries 5xx and network errors) sets
// the same numbers again: safe to repeat.
//
// Per-SKU errors come back in `data.errors` with a top-level code 0 (§0): every SKU an error names is a
// failure with that code; an error that names no SKU of this call fails every SKU of it (A4: the shape
// is checked in T0, and an unknown shape is never read as a success). Only codes leave this module,
// never TikTok's message.

const ID_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;
const MAX_QUANTITY = 999_999;

interface ShopCall {
  accessToken: Secret;
  shopCipher: string;
  /** Epoch ms: the caller's time budget. */
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

export interface TikTokInventoryUpdateSku {
  skuId: string;
  /** Ammari's own (non-FBT) warehouse for this SKU. */
  warehouseId: string;
  quantity: number;
}

export interface UpdateTikTokInventoryInput extends ShopCall {
  productId: string;
  skus: readonly TikTokInventoryUpdateSku[];
}

export type TikTokInventorySkuResult = { ok: true } | { ok: false; code: string };

const dataSchema = z.union([z.undefined(), z.null(), z.object({ errors: z.array(z.unknown()).max(1000).nullish() })]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole-number code, as a JSON number or a numeric string (either shape names the same §0 code). */
function codeOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^[0-9]{1,12}$/.test(value)) return value;
  return null;
}

/** Codes the stock rules name (§0): one of them inside `extra_errors` beats a generic outer code. */
const NAMED_CODES = new Set(["12052393", "12052141", "12052921", "12052901", "12052556", "12052036", "12052097", "12052530", "12052531"]);

function readError(raw: unknown): { skuId: string | null; code: string } {
  if (!isObject(raw)) return { skuId: null, code: "invalid_response" };
  const detail = isObject(raw.detail) ? raw.detail : {};
  const skuValue = typeof raw.sku_id === "string" ? raw.sku_id : typeof detail.sku_id === "string" ? detail.sku_id : null;
  const skuId = skuValue !== null && ID_PATTERN.test(skuValue) ? skuValue : null;
  const outer = codeOf(raw.code);
  const extra = Array.isArray(detail.extra_errors) ? detail.extra_errors.filter(isObject).map((entry) => codeOf(entry.code)) : [];
  const named = [outer, ...extra].find((code): code is string => code !== null && NAMED_CODES.has(code));
  return { skuId, code: named ?? outer ?? "invalid_response" };
}

function refuse(reason: string): never {
  throw new Error(`updateTikTokInventory: ${reason}`);
}

/** Sends one product's quantities. Returns one result per SKU sent. Throws a TikTokApiError for a
 * refused call (a top-level code), a rate limit, an outage or a network failure (nothing known to be
 * written: the caller retries), and a plain Error for an input that must never be sent. */
export async function updateTikTokInventory(client: TikTokClient, input: UpdateTikTokInventoryInput): Promise<Map<string, TikTokInventorySkuResult>> {
  if (!ID_PATTERN.test(input.productId)) refuse("unusable product id");
  if (input.skus.length === 0 || input.skus.length > UPDATE_INVENTORY_MAX_SKUS) refuse(`1-${UPDATE_INVENTORY_MAX_SKUS} SKUs per call`);
  const seen = new Set<string>();
  for (const sku of input.skus) {
    if (!ID_PATTERN.test(sku.skuId)) refuse("unusable SKU id");
    if (!ID_PATTERN.test(sku.warehouseId)) refuse("unusable warehouse id");
    if (!Number.isSafeInteger(sku.quantity) || sku.quantity < 0 || sku.quantity > MAX_QUANTITY) refuse("quantity must be a whole number 0-999999");
    if (seen.has(sku.skuId)) refuse("a SKU given twice");
    seen.add(sku.skuId);
  }
  const data = await client.request({
    method: "POST",
    path: TIKTOK_ENDPOINTS.updateInventory(input.productId),
    body: {
      skus: input.skus.map((sku) => ({ id: sku.skuId, inventory: [{ warehouse_id: sku.warehouseId, quantity: sku.quantity }] })),
      sku_warehouse_stock_update_mode: "INCREMENTAL",
    },
    accessToken: input.accessToken,
    shopCipher: input.shopCipher,
    schema: dataSchema,
    deadline: input.deadline,
    onAuthError: input.onAuthError,
  });

  const results = new Map<string, TikTokInventorySkuResult>(input.skus.map((sku) => [sku.skuId, { ok: true }]));
  let everySku: string | null = null;
  for (const raw of data?.errors ?? []) {
    const error = readError(raw);
    if (error.skuId !== null && results.has(error.skuId)) results.set(error.skuId, { ok: false, code: error.code });
    else everySku ??= error.code;
  }
  if (everySku !== null) {
    for (const [skuId, result] of results) if (result.ok) results.set(skuId, { ok: false, code: everySku });
  }
  return results;
}
