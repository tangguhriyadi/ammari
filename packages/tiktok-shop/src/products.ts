import "server-only";
import { z } from "zod";
import { TikTokApiError, type TikTokClient } from "./client";
import { SEARCH_PRODUCTS_MAX_PAGE_SIZE, TIKTOK_ENDPOINTS } from "./endpoints";
import type { Secret } from "./secret";

// The listing read side for the stock sync (docs/plans/tiktok-stock-sync.md §4, S1): Search Products
// and Get Warehouse List, read only (`seller.product.basic`, `seller.logistics`). The Update Inventory
// write call is S2 and does not exist yet.
//
// Field names follow TikTok's 202309 objects and are assumptions A1/A2 to check in T0 (§8): a list key
// TikTok names differently is refused as `invalid_response`, never read as an empty shop (an empty
// read would mark every listing `not_listed`). Only ids, statuses, the product title, a SKU label and
// per-warehouse quantities leave this module; a warehouse's name and address never do.

const ID_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;
const STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const TIKTOK_PRODUCT_TITLE_MAX_CHARS = 255;

interface ShopCall {
  accessToken: Secret;
  shopCipher: string;
  /** Epoch ms: the run's time budget. */
  deadline: number;
  onAuthError?: () => Promise<Secret>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

/** Display text: NUL and lone surrogates removed, trimmed, cut by code point. Empty → null. */
function displayText(value: unknown, max = TIKTOK_PRODUCT_TITLE_MAX_CHARS): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

export interface TikTokInventoryEntry {
  warehouse_id: string | null;
  /** As TikTok sent it; the stock rules decide whether it is a usable whole number. */
  quantity: unknown;
}

export interface TikTokListingSkuRecord {
  skuId: string;
  sellerSku: string | null;
  /** The sales attributes' values ("Sage · M"), display only. */
  label: string | null;
  inventory: TikTokInventoryEntry[];
}

export interface TikTokListingProductRecord {
  productId: string;
  status: string;
  title: string | null;
  skus: TikTokListingSkuRecord[];
  /** How many SKU entries TikTok listed (usable or not): the 100-per-product limit is on this. */
  skuCount: number;
  /** SKU entries without a usable id. */
  invalidSkus: number;
}

/** Every entry is kept: one that is not an object, or has no usable warehouse id, stays as
 * `warehouse_id: null`, and the stock rules then hold the SKU (`warehouse_unclear`), so a second
 * own-warehouse entry in an unexpected shape can never be dropped silently. */
function inventoryOf(value: unknown): TikTokInventoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (isObject(entry) ? entry : {})).map((entry) => ({
    warehouse_id: typeof entry.warehouse_id === "string" && ID_PATTERN.test(entry.warehouse_id) ? entry.warehouse_id : null,
    // Only a number or a short string is passed on (never an object TikTok might nest here).
    quantity: typeof entry.quantity === "number" || (typeof entry.quantity === "string" && entry.quantity.length <= 32) ? entry.quantity : null,
  }));
}

function labelOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter(isObject).map((attribute) => displayText(attribute.value_name, 64)).filter((part): part is string => part !== null);
  return parts.length > 0 ? displayText(parts.join(" · ")) : null;
}

function productOf(raw: unknown): TikTokListingProductRecord | null {
  if (!isObject(raw)) return null;
  const productId = idOf(raw.id);
  const status = typeof raw.status === "string" && STATUS_PATTERN.test(raw.status) ? raw.status : null;
  // A missing or renamed `skus` list is not "a product with no SKUs": its SKUs would be marked
  // not_listed. Such a product is invalid (the pass is then incomplete). An empty list is fine.
  if (!productId || !status || !Array.isArray(raw.skus)) return null;
  const rawSkus: unknown[] = raw.skus;
  const skus: TikTokListingSkuRecord[] = [];
  let invalidSkus = 0;
  for (const sku of rawSkus) {
    const skuId = isObject(sku) ? idOf(sku.id) : null;
    if (!isObject(sku) || !skuId) {
      invalidSkus += 1;
      continue;
    }
    skus.push({ skuId, sellerSku: displayText(sku.seller_sku, 128), label: labelOf(sku.sales_attributes), inventory: inventoryOf(sku.inventory) });
  }
  return { productId, status, title: displayText(raw.title), skus, skuCount: rawSkus.length, invalidSkus };
}

const searchSchema = z.object({
  products: z.array(z.unknown()).max(SEARCH_PRODUCTS_MAX_PAGE_SIZE).optional(),
  next_page_token: z.string().max(4096).optional(),
  total_count: z.number().int().nonnegative().optional(),
});

export interface SearchTikTokProductsInput extends ShopCall {
  pageToken?: string | null;
  pageSize?: number;
}

export interface SearchTikTokProductsPage {
  products: TikTokListingProductRecord[];
  /** Product entries on this page, usable or not (compared with `totalCount` by the caller). */
  entries: number;
  /** TikTok's `total_count`, when sent. */
  totalCount: number | null;
  /** Product entries without a usable id or status (the caller holds the pass on them). */
  invalid: number;
  nextPageToken: string | null;
}

/** One page of Search Products (every status: an empty filter, assumption A1). */
export async function searchTikTokProducts(client: TikTokClient, input: SearchTikTokProductsInput): Promise<SearchTikTokProductsPage> {
  const pageSize = input.pageSize ?? SEARCH_PRODUCTS_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SEARCH_PRODUCTS_MAX_PAGE_SIZE) throw new Error("searchTikTokProducts: page_size must be 1-100");
  const path = TIKTOK_ENDPOINTS.searchProducts;
  const data = await client.request({
    method: "POST",
    path,
    query: { page_size: pageSize, ...(input.pageToken ? { page_token: input.pageToken } : {}) },
    body: {},
    accessToken: input.accessToken,
    shopCipher: input.shopCipher,
    schema: searchSchema,
    deadline: input.deadline,
    onAuthError: input.onAuthError,
  });
  // No list and TikTok did not say the shop is empty: a renamed key, never "no products".
  if (data.products === undefined && data.total_count !== 0) throw new TikTokApiError({ kind: "invalid_response", path, httpStatus: null, code: null, requestId: null, detail: "products_missing" });
  const products: TikTokListingProductRecord[] = [];
  let invalid = 0;
  for (const raw of data.products ?? []) {
    const product = productOf(raw);
    if (product) products.push(product);
    else invalid += 1;
  }
  const token = data.next_page_token?.trim() ?? "";
  return { products, entries: (data.products ?? []).length, totalCount: data.total_count ?? null, invalid, nextPageToken: token === "" ? null : token };
}

export interface TikTokWarehouse {
  id: string;
  type: string | null;
  subType: string | null;
}

const warehousesSchema = z.object({ warehouses: z.array(z.unknown()).max(1000) });

/** Get Warehouse List. Only id, type and sub type are kept. */
export async function getTikTokWarehouses(client: TikTokClient, call: ShopCall): Promise<{ warehouses: TikTokWarehouse[]; invalid: number }> {
  const data = await client.request({
    method: "GET",
    path: TIKTOK_ENDPOINTS.warehouses,
    accessToken: call.accessToken,
    shopCipher: call.shopCipher,
    schema: warehousesSchema,
    deadline: call.deadline,
    onAuthError: call.onAuthError,
  });
  const warehouses: TikTokWarehouse[] = [];
  let invalid = 0;
  for (const raw of data.warehouses) {
    const id = isObject(raw) ? idOf(raw.id) : null;
    if (!isObject(raw) || !id) {
      invalid += 1;
      continue;
    }
    const token = (value: unknown) => (typeof value === "string" && STATUS_PATTERN.test(value) ? value : null);
    warehouses.push({ id, type: token(raw.type), subType: token(raw.sub_type) });
  }
  return { warehouses, invalid };
}

/** Ammari's own warehouses (assumption A2): domestic sales warehouses. Everything else (FBT, a return
 * warehouse, a cross-border one, an unknown shape) is never Ammari's and never pushed to. */
export function ownTikTokWarehouseIds(warehouses: readonly TikTokWarehouse[]): Set<string> {
  return new Set(warehouses.filter((w) => w.type === "SALES_WAREHOUSE" && w.subType === "DOMESTIC_WAREHOUSE").map((w) => w.id));
}
