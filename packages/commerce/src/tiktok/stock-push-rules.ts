import { TIKTOK_LISTING_HOLD_REASONS, type TikTokListingHoldReason } from "@ammari/db/schema";
import type { TikTokTargetHoldReason, TikTokTargetResult } from "./stock-sync-rules";

// TikTok stock sync S2, the pure rules of the push (docs/plans/tiktok-stock-sync.md §7). No database,
// no TikTok, no clock of their own. The push (stock-push.ts) feeds them what it re-read under the
// product's lock, so what is sent is always recomputed at send time, never a queued value.
//
// Every rule only ever holds: a row it cannot vouch for is never sent.

/** R11: a listing row whose last read is older than this is never pushed to (re-read it first). */
export const TIKTOK_STOCK_LISTING_MAX_AGE_MS = 2 * 60 * 60_000;
/** Update Inventory takes at most this many SKUs per product (R8). */
export const TIKTOK_STOCK_PUSH_MAX_SKUS = 100;
export const TIKTOK_STOCK_PUSH_MIN_BACKOFF_MS = 60_000;
export const TIKTOK_STOCK_PUSH_MAX_BACKOFF_MS = 60 * 60_000;

/** Why a SKU is not pushed now, on top of the listing's and the target's own reasons. */
export type TikTokPushHoldReason =
  | TikTokListingHoldReason
  | TikTokTargetHoldReason
  /** The active mapping names another variant than the read stored: wait for the next read. */
  | "mapping_changed"
  /** R11: the row was not read in the last 2 hours. */
  | "listing_stale"
  /** TikTok refused the last push for a reason only a person can fix (promotion lock, global
   * product, shared inventory): held until "Kirim ulang" on the tab. */
  | "push_refused"
  /** TikTok refused the last push for the listing's status, SKU or warehouse: held until a newer read. */
  | "awaiting_reread";

export interface TikTokPushCandidate {
  skuId: string;
  /** The variant the ACTIVE tiktok_sku_mappings row names now (re-resolved at push time); null = unmapped. */
  mappedVariantSku: string | null;
  /** What the last read stored on the listing row. */
  listingVariantSku: string | null;
  /** The listing row's stored hold reason, raw (an unknown one fails closed). */
  listingHoldReason: string | null;
  warehouseId: string | null;
  tiktokQuantity: number | null;
  readAt: Date;
  lastPushedQuantity: number | null;
  lastPushedAt: Date | null;
  lastPushErrorCode: string | null;
  lastPushErrorAt: Date | null;
  /** R7 at push time: listings of the connection whose active mapping names this variant and that are
   * pushable apart from R7 (this one included). More than one → held. */
  listingsForVariant: number;
  target: TikTokTargetResult;
}

export type TikTokPushDecision = { kind: "send"; quantity: number } | { kind: "unchanged"; quantity: number } | { kind: "held"; reason: TikTokPushHoldReason };

// ---- Errors (§0) --------------------------------------------------------------------------------

export type TikTokPushRefusal = "promotion_locked" | "global_product" | "shared_inventory" | "status" | "sku" | "warehouse";

export type TikTokPushErrorAction = { action: "hold"; reason: TikTokPushRefusal; reread: boolean } | { action: "retry" };

/** Owner facts (28 Nov 2026, §0). Held until a person acts: retrying cannot help. */
const PERSON_HOLDS: ReadonlyMap<string, TikTokPushRefusal> = new Map([
  ["12052393", "promotion_locked"],
  ["12052141", "global_product"],
  ["12052921", "shared_inventory"],
]);
/** Held until the next read pass saw the listing again (its status, SKU or warehouse changed). */
const REREAD_HOLDS: ReadonlyMap<string, TikTokPushRefusal> = new Map([
  ["12052901", "status"],
  ["12052556", "sku"],
  ["12052036", "sku"],
  ["12052097", "warehouse"],
  ["12052530", "warehouse"],
  ["12052531", "warehouse"],
]);

/** Every TikTok code that holds a SKU (a person, or a re-read): the health counts these. */
export const TIKTOK_STOCK_HOLD_CODES: readonly string[] = [...PERSON_HOLDS.keys(), ...REREAD_HOLDS.keys()];

/** TikTok codes that hold a pushed SKU until the next listing read sees it again. */
export const TIKTOK_STOCK_REREAD_CODES: readonly string[] = [...REREAD_HOLDS.keys()];

/** A stored push error code (TikTok's numeric code as text, or the client's error kind) → what to do.
 * Anything not named in §0 (a rate limit, an outage, a network failure, an unknown code) is retried
 * with backoff: it never holds a SKU for good, and it shows on the tab and in the cron log. */
export function tiktokStockPushErrorAction(code: string): TikTokPushErrorAction {
  const person = PERSON_HOLDS.get(code);
  if (person) return { action: "hold", reason: person, reread: false };
  const reread = REREAD_HOLDS.get(code);
  if (reread) return { action: "hold", reason: reread, reread: true };
  return { action: "retry" };
}

/** Retry delay after `failures` failed attempts in a row: 1, 2, 4 ... minutes, at most an hour. */
export function tiktokStockPushBackoffMs(failures: number): number {
  const n = Number.isSafeInteger(failures) && failures >= 1 ? failures : 1;
  // 2^(n-1) minutes; past 2^6 it is above the cap anyway, so the exponent never overflows.
  const minutes = 2 ** Math.min(n - 1, 10);
  return Math.min(TIKTOK_STOCK_PUSH_MAX_BACKOFF_MS, minutes * TIKTOK_STOCK_PUSH_MIN_BACKOFF_MS);
}

// ---- Deciding one SKU -----------------------------------------------------------------------------

const KNOWN_LISTING_HOLDS: ReadonlySet<string> = new Set(TIKTOK_LISTING_HOLD_REASONS);

/** One SKU: held (and why), unchanged, or the quantity to send. */
export function decideTikTokSkuPush(c: TikTokPushCandidate, now: Date): TikTokPushDecision {
  // R6: never touch an unmapped SKU (re-resolved now, decision 3).
  if (c.mappedVariantSku === null) return { kind: "held", reason: "unmapped" };
  if (c.listingVariantSku !== c.mappedVariantSku) return { kind: "held", reason: "mapping_changed" };
  if (c.listingHoldReason !== null && c.listingHoldReason !== "variant_on_several_listings") {
    return { kind: "held", reason: KNOWN_LISTING_HOLDS.has(c.listingHoldReason) ? (c.listingHoldReason as TikTokListingHoldReason) : "invalid_input" };
  }
  // R7 from the tables, never from the stored hold alone (a mapping can change between reads).
  if (c.listingsForVariant !== 1) return { kind: "held", reason: c.listingsForVariant > 1 ? "variant_on_several_listings" : "invalid_input" };
  if (c.warehouseId === null) return { kind: "held", reason: "warehouse_unclear" };
  if (c.tiktokQuantity === null) return { kind: "held", reason: "quantity_unreadable" };
  if (now.getTime() - c.readAt.getTime() > TIKTOK_STOCK_LISTING_MAX_AGE_MS) return { kind: "held", reason: "listing_stale" };
  if (c.lastPushErrorCode !== null) {
    const action = tiktokStockPushErrorAction(c.lastPushErrorCode);
    if (action.action === "hold" && !action.reread) return { kind: "held", reason: "push_refused" };
    // A re-read error holds until a read NEWER than the refusal saw the listing again.
    if (action.action === "hold" && action.reread && (c.lastPushErrorAt === null || c.lastPushErrorAt.getTime() >= c.readAt.getTime())) return { kind: "held", reason: "awaiting_reread" };
  }
  if (c.target.kind === "hold") return { kind: "held", reason: c.target.reason };
  const quantity = c.target.quantity;

  if (c.lastPushedQuantity === null || c.lastPushedAt === null) {
    // First push for this SKU: compare with what TikTok showed, so the first sync really overwrites.
    return quantity === c.tiktokQuantity ? { kind: "unchanged", quantity } : { kind: "send", quantity };
  }
  if (quantity !== c.lastPushedQuantity) return { kind: "send", quantity };
  // Same as last pushed. A read that predates the push says nothing about drift; a newer read that
  // disagrees (a Seller Center edit) is overwritten (decision 3).
  const readAfterPush = c.readAt.getTime() > c.lastPushedAt.getTime();
  return readAfterPush && c.tiktokQuantity !== quantity ? { kind: "send", quantity } : { kind: "unchanged", quantity };
}

export interface TikTokProductPushPlan {
  /** The Update Inventory body's SKUs, in input order. Empty → no call. */
  send: { skuId: string; warehouseId: string; quantity: number }[];
  decisions: Map<string, TikTokPushDecision>;
}

/** One product: one call with every dirty SKU to send. More than 100 → nothing is sent (R8). */
export function planTikTokProductPush(candidates: readonly TikTokPushCandidate[], now: Date): TikTokProductPushPlan {
  const decisions = new Map<string, TikTokPushDecision>();
  const send: TikTokProductPushPlan["send"] = [];
  for (const c of candidates) {
    if (decisions.has(c.skuId)) throw new Error(`planTikTokProductPush: TikTok SKU ${c.skuId} given twice`);
    const decision = decideTikTokSkuPush(c, now);
    decisions.set(c.skuId, decision);
    if (decision.kind === "send") send.push({ skuId: c.skuId, warehouseId: c.warehouseId as string, quantity: decision.quantity });
  }
  if (send.length > TIKTOK_STOCK_PUSH_MAX_SKUS) {
    for (const entry of send) decisions.set(entry.skuId, { kind: "held", reason: "product_too_many_skus" });
    return { send: [], decisions };
  }
  return { send, decisions };
}
