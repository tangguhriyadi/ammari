import { MARKETPLACE_CHANNEL_IDS, type ChannelId, type Size } from "@ammari/db/schema";

/** One constant mapping, keyed off the existing frozen `ChannelId` enum (the `channels` table
 * is itself constrained to exactly this set — see `packages/db/src/schema/constants.ts`'s
 * `CHANNEL_IDS`) — no extra DB join needed since the mapping never varies per row.
 * docs/plans/thermal-stickers.md. */
export const CHANNEL_STICKER_CODE: Record<ChannelId, string> = {
  shopee: "SHP",
  tiktok: "TTS",
  web: "WEB",
  whatsapp: "WA",
  instagram: "IG",
  offline: "OFF",
  reseller: "RSL",
};

export interface StickerCodeItem {
  productName: string;
  colorName: string;
  size: Size;
  qty: number;
}

export interface StickerCodeOrderInput {
  orderId: string;
  channelId: ChannelId;
  /** Internal order number (e.g. "ORD-251015-0012") — the LAST4 source for non-marketplace
   * channels, and the fallback when a marketplace order is unexpectedly missing its own. */
  orderNo: string;
  /** The marketplace's own order id — the LAST4 source for shopee/tiktok. */
  channelOrderNo: string | null;
  /** At least one item; `buildStickerCodeBase` throws otherwise (every real order has ≥1 item —
   * this is a defensive invariant check, not an expected runtime case). */
  items: StickerCodeItem[];
}

/** A code already persisted on another card — used only as collision context, never
 * recomputed: an already-printed sticker's code is physically fixed until that card is
 * reprinted. */
export interface StickerCodeFixed {
  orderId: string;
  code: string;
}

/** Strips accents (NFD + drop combining marks) and anything that isn't a plain ASCII letter,
 * uppercases, and takes the first 2 characters — e.g. "Sage" -> "SA", "Cyra" -> "CY". Literal
 * "first 2 letters of the string," not word-initials (confirmed against the owner's own
 * worked examples). */
function first2Letters(name: string): string {
  const lettersOnly = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z]/g, "");
  return lettersOnly.slice(0, 2).toUpperCase();
}

/** Keeps only alphanumeric characters (drops dashes/spaces from an order number), then takes
 * the last `length` characters, uppercased. */
function alphanumericSuffix(value: string, length: number): string {
  const alnum = value.replace(/[^A-Za-z0-9]/g, "");
  return alnum.slice(-length).toUpperCase();
}

function sizeCode(size: Size): string {
  return size === "ALLSIZE" ? "AS" : size;
}

/** Sorts items the SAME stable way regardless of input order, so two calls for the same order's
 * items always pick the same "first" one for MODEL/COLOR/SIZE — product name, then color, then
 * size (docs/plans/thermal-stickers.md). */
function firstItem(items: StickerCodeItem[]): StickerCodeItem {
  const sorted = [...items].sort(
    (a, b) => a.productName.localeCompare(b.productName) || a.colorName.localeCompare(b.colorName) || a.size.localeCompare(b.size),
  );
  const first = sorted[0];
  if (!first) throw new Error("buildStickerCodeBase: order has no items");
  return first;
}

/** One order's code, computed independently of every other order — `last4Length` is 4 by
 * default, widened to 6 only by `assignStickerCodes` below when two orders in the same scope
 * would otherwise collide. Never called directly by application code outside this module (use
 * `assignStickerCodes`), kept exported purely so tests can check the base derivation in
 * isolation from collision handling. */
export function buildStickerCodeBase(order: StickerCodeOrderInput, last4Length: 4 | 6 = 4): string {
  const channel = CHANNEL_STICKER_CODE[order.channelId];
  const first = firstItem(order.items);
  const model = first2Letters(first.productName);
  const color = first2Letters(first.colorName);
  const size = sizeCode(first.size);

  const isMarketplace = MARKETPLACE_CHANNEL_IDS.includes(order.channelId);
  // A marketplace order missing its own channel order number is unexpected, but this is display/
  // print data, not a security boundary — falling back to the internal order number rather than
  // throwing keeps one bad row from blocking an entire print batch.
  const last4Source = isMarketplace && order.channelOrderNo ? order.channelOrderNo : order.orderNo;
  const last4 = alphanumericSuffix(last4Source, last4Length);

  const base = `${channel}-${model}-${color}-${size}-${last4}`;
  const totalPieces = order.items.reduce((sum, item) => sum + item.qty, 0);
  return totalPieces > 1 ? `${base} x${totalPieces}` : base;
}

/** The real entry point. Computes every order in `pending`'s code, then widens LAST4 to 6
 * characters (one escalation level, matching the owner's spec) for any order whose base code
 * collides with ANOTHER pending order's code OR with an already-persisted `fixed` code —
 * `fixed` entries are never themselves recomputed, since their codes are physically already
 * printed. This is the one place collision scope is decided: callers choose what's "pending"
 * (needs a code) vs. "fixed" (already has one) — see docs/plans/thermal-stickers.md for the two
 * call sites (the `/packing` preview, scoped to the whole to_ship queue, and the print action,
 * scoped to the exact batch being minted). */
export function assignStickerCodes(pending: StickerCodeOrderInput[], fixed: StickerCodeFixed[] = []): Map<string, string> {
  const baseCodes = new Map(pending.map((order) => [order.orderId, buildStickerCodeBase(order)] as const));

  const counts = new Map<string, number>();
  for (const code of baseCodes.values()) counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const entry of fixed) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);

  const result = new Map<string, string>();
  for (const order of pending) {
    const base = baseCodes.get(order.orderId)!;
    const collides = (counts.get(base) ?? 0) > 1;
    result.set(order.orderId, collides ? buildStickerCodeBase(order, 6) : base);
  }
  return result;
}
