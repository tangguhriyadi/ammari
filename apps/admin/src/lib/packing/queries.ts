import "server-only";
import { and, asc, count, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import {
  channels,
  customers,
  fabricColors,
  orderItems,
  orders,
  productImages,
  products,
  productVariants,
  thankYouCards,
} from "@ammari/db/schema";
import type { ChannelId, Size } from "@ammari/db/schema";
import { orderBuyerNameSql } from "@/lib/orders/buyer-name";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { buildImageSizeUrl } from "@/lib/products/image-queries";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { generateClaimToken, hashClaimToken } from "./token";
import { resolveCardBuyerName } from "./card-copy";
import { assignStickerCodes, type StickerCodeFixed, type StickerCodeOrderInput } from "./sticker-code";

// ---------- Claim deadline ----------

const JAKARTA_YMD_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function jakartaYmd(date: Date): { year: number; month: number; day: number } {
  const parts = JAKARTA_YMD_FORMATTER.formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return { year, month, day };
}

/** `orderDate` (Asia/Jakarta calendar date) + 1 calendar month, 23:59:59 WIB (docs/SPEC.md §4.4),
 * clamped to the last day of the TARGET month when the source day doesn't exist there (approved
 * plan decision — 31 Jan never silently rolls into early March the way naive `Date` month
 * arithmetic would). `Date.UTC(year, month, 0)` is a pure calendar-math trick (day 0 of a month
 * is the last day of the PREVIOUS month) — it's not claiming that moment is actually midnight
 * UTC anywhere real, it's only ever used here to ask "how many days are in this month." */
export function claimDeadlineFromOrderDate(orderDate: Date): Date {
  const { year, month, day } = jakartaYmd(orderDate);
  let targetYear = year;
  let targetMonth = month + 1;
  if (targetMonth > 12) {
    targetMonth = 1;
    targetYear += 1;
  }
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  const mm = String(targetMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return new Date(`${targetYear}-${mm}-${dd}T23:59:59+07:00`);
}

// ---------- Packing queue ----------

export interface PackingQueueRow {
  id: string;
  orderNo: string;
  channelId: ChannelId;
  channelName: string;
  customerName: string | null;
  buyerUsername: string | null;
  orderDate: Date;
  /** `null` = no active card printed yet. */
  cardPrintedAt: Date | null;
  /** `null` = not claimed (yet, or ever) — set once a buyer claims this order's card on the
   * main site (`apps/web`'s `/claim/[token]`, docs/plans/voucher-claim.md session 2). */
  cardClaimedAt: Date | null;
  /** The sticker code shown on `/packing` (docs/plans/thermal-stickers.md). `null` only for a
   * card printed before this feature shipped (no backfill) — the UI shows a plain dash then.
   * Real (non-preview) once an active card exists; see `stickerCodeIsPreview`. */
  stickerCode: string | null;
  /** `true` = this order has no active card yet, so `stickerCode` is a PREVIEW computed over the
   * whole to_ship queue right now — it can still change (another order joining/leaving the
   * queue could shift collision handling) until the order is actually printed, at which point
   * the exact code gets persisted on its card and `stickerCodeIsPreview` becomes `false`. */
  stickerCodeIsPreview: boolean;
  /** A web checkout order (`payment_status` set, docs/plans/cart-checkout.md §7): no thank-you
   * card (SPEC §4.1, marketplace orders only), and staff book `shippingServiceLabel`. */
  isCheckout: boolean;
  /** The quoted courier service locked on a checkout order (e.g. "JNE Reguler"); null otherwise. */
  shippingServiceLabel: string | null;
}

export interface PackingPickListItem {
  orderId: string;
  sku: string;
  productName: string;
  colorName: string;
  size: Size;
  qty: number;
  thumbnailUrl: string | null;
}

export interface ListPackingQueueFilters {
  channelId?: ChannelId;
}

/** The /packing queue: every `to_ship` order, oldest `orderDate` first (the owner's own
 * requirement — pack what's been waiting longest), optionally filtered to one channel. Returns
 * the queue rows AND every item across the whole page in one extra query (never N+1 — same
 * discipline as every other list page in this codebase), grouped by orderId by the caller. */
export async function listPackingQueue(
  filters: ListPackingQueueFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: PackingQueueRow[]; items: Map<string, PackingPickListItem[]>; pagination: Pagination }> {
  const conditions = [eq(orders.status, "to_ship"), filters.channelId ? eq(orders.channelId, filters.channelId) : undefined].filter(
    (c) => c !== undefined,
  );
  const where = and(...conditions);

  const [totalCountRow] = await db.select({ totalCount: count() }).from(orders).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const activeCard = db
    .select({ orderId: thankYouCards.orderId, printedAt: thankYouCards.createdAt, stickerCode: thankYouCards.stickerCode })
    .from(thankYouCards)
    .where(eq(thankYouCards.status, "active"))
    .as("active_card");

  // A reprint voids the previous active card, so at most one `active` row ever exists per
  // order — but a card that's since been CLAIMED is no longer `active` (its own status moved to
  // `claimed`), hence the separate join: the two states are mutually exclusive per order, never
  // both populated for the same row.
  const claimedCard = db
    .select({ orderId: thankYouCards.orderId, claimedAt: thankYouCards.claimedAt })
    .from(thankYouCards)
    .where(eq(thankYouCards.status, "claimed"))
    .as("claimed_card");

  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channels.name,
      customerName: orderBuyerNameSql(),
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      cardPrintedAt: activeCard.printedAt,
      cardClaimedAt: claimedCard.claimedAt,
      persistedStickerCode: activeCard.stickerCode,
      paymentStatus: orders.paymentStatus,
      shippingServiceLabel: orders.shippingCourierLabel,
    })
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(activeCard, eq(activeCard.orderId, orders.id))
    .leftJoin(claimedCard, eq(claimedCard.orderId, orders.id))
    .where(where)
    .orderBy(asc(orders.orderDate), asc(orders.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const orderIds = rows.map((row) => row.id);
  const items = orderIds.length > 0 ? await listPickListItems(orderIds, db) : new Map<string, PackingPickListItem[]>();

  // Sticker-code preview (docs/plans/thermal-stickers.md): scoped to the WHOLE to_ship queue —
  // never just this page, and never narrowed by `filters.channelId` either — a collision between
  // two orders must be caught even if the staffer is currently looking at a single-channel
  // filtered view that only shows one of them. Orders that already have an active card show
  // their PERSISTED code instead (never recomputed here); only genuinely unprinted orders need a
  // preview.
  const unprintedOrderIds = await getUnprintedToShipOrderIds(db);
  const fixedEntries = await getFixedStickerCodesForToShipQueue([], db);
  const previewInputs = await getStickerCodeInputsForOrders(unprintedOrderIds, db);
  const previewMap = assignStickerCodes(previewInputs, fixedEntries);

  const rowsWithStickerCodes: PackingQueueRow[] = rows.map(({ persistedStickerCode, paymentStatus, ...row }) => {
    const isPrinted = row.cardPrintedAt !== null;
    const isCheckout = paymentStatus !== null;
    return {
      ...row,
      // A checkout order never gets a card, so it has no sticker code either.
      stickerCode: isCheckout ? null : isPrinted ? persistedStickerCode : (previewMap.get(row.id) ?? null),
      stickerCodeIsPreview: !isCheckout && !isPrinted,
      isCheckout,
    };
  });

  return { rows: rowsWithStickerCodes, items, pagination };
}

/** Every `to_ship` order with NO active thank-you card — the "pending" set for the sticker-code
 * preview (docs/plans/thermal-stickers.md): these are the orders whose code could still change
 * before they're actually printed. Web checkout orders never get a card, so they are not in it. */
async function getUnprintedToShipOrderIds(db: Database): Promise<string[]> {
  const activeCardOrderIds = db.select({ orderId: thankYouCards.orderId }).from(thankYouCards).where(eq(thankYouCards.status, "active"));
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "to_ship"), isNull(orders.paymentStatus), notInArray(orders.id, activeCardOrderIds)));
  return rows.map((r) => r.id);
}

/** Already-persisted sticker codes for every `to_ship` order's active card, excluding
 * `excludeOrderIds` (the batch currently being (re)minted, whose old code is about to be
 * replaced) — this is the "fixed" collision context `assignStickerCodes` never recomputes.
 * Cards minted before this feature shipped have `stickerCode: null` and are simply excluded
 * (they impose no collision constraint — see the schema's own doc comment on why there's no
 * backfill). */
async function getFixedStickerCodesForToShipQueue(excludeOrderIds: string[], db: Database): Promise<StickerCodeFixed[]> {
  const conditions = [
    eq(thankYouCards.status, "active"),
    eq(orders.status, "to_ship"),
    excludeOrderIds.length > 0 ? notInArray(thankYouCards.orderId, excludeOrderIds) : undefined,
  ].filter((c) => c !== undefined);

  const rows = await db
    .select({ orderId: thankYouCards.orderId, code: thankYouCards.stickerCode })
    .from(thankYouCards)
    .innerJoin(orders, eq(orders.id, thankYouCards.orderId))
    .where(and(...conditions));

  return rows.filter((r): r is { orderId: string; code: string } => r.code !== null);
}

/** Everything `buildStickerCodeBase`/`assignStickerCodes` needs for a batch of orders — channel,
 * both order-number forms, and every item (reusing the same pick-list-items query the queue
 * display already runs, rather than re-deriving the same joins a second way). */
export async function getStickerCodeInputsForOrders(orderIds: string[], db: Database): Promise<StickerCodeOrderInput[]> {
  if (orderIds.length === 0) return [];
  const [orderRows, itemsByOrderId] = await Promise.all([
    db
      .select({ id: orders.id, channelId: orders.channelId, orderNo: orders.orderNo, channelOrderNo: orders.channelOrderNo })
      .from(orders)
      .where(inArray(orders.id, orderIds)),
    listPickListItems(orderIds, db),
  ]);

  return orderRows.map((order) => ({
    orderId: order.id,
    channelId: order.channelId,
    orderNo: order.orderNo,
    channelOrderNo: order.channelOrderNo,
    items: (itemsByOrderId.get(order.id) ?? []).map((item) => ({
      productName: item.productName,
      colorName: item.colorName,
      size: item.size,
      qty: item.qty,
    })),
  }));
}

async function listPickListItems(orderIds: string[], db: Database): Promise<Map<string, PackingPickListItem[]>> {
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      sku: orderItems.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      thumbnailStorageKey: productImages.storageKey,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(productImages, eq(productImages.id, products.thumbnailImageId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.createdAt));

  const map = new Map<string, PackingPickListItem[]>();
  for (const { thumbnailStorageKey, ...row } of rows) {
    const list = map.get(row.orderId) ?? [];
    list.push({ ...row, thumbnailUrl: thumbnailStorageKey ? buildImageSizeUrl(thumbnailStorageKey, 400) : null });
    map.set(row.orderId, list);
  }
  return map;
}

// ---------- Card print status (for the bulk-reprint warning) ----------

export async function getCardPrintStatus(orderIds: string[], db: Database = defaultDb): Promise<Map<string, boolean>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({ orderId: thankYouCards.orderId })
    .from(thankYouCards)
    .where(and(inArray(thankYouCards.orderId, orderIds), eq(thankYouCards.status, "active")));
  const activeOrderIds = new Set(rows.map((r) => r.orderId));
  return new Map(orderIds.map((id) => [id, activeOrderIds.has(id)]));
}

/** The orders among `orderIds` that should carry a thank-you card but have no active one, for the
 * "Tandai dikirim" warning. Web checkout orders never need one (SPEC §4.1). */
export async function getOrdersMissingCard(orderIds: string[], db: Database = defaultDb): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const [status, checkoutRows] = await Promise.all([
    getCardPrintStatus(orderIds, db),
    db.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, orderIds), isNotNull(orders.paymentStatus))),
  ]);
  const checkout = new Set(checkoutRows.map((row) => row.id));
  return orderIds.filter((id) => !checkout.has(id) && status.get(id) === false);
}

/** The order numbers of the web checkout orders among `orderIds` (bulk "Tandai dikirim" refuses
 * them: they ship one by one with a resi). */
export async function getCheckoutOrderNos(orderIds: string[], db: Database = defaultDb): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .select({ orderNo: orders.orderNo })
    .from(orders)
    .where(and(inArray(orders.id, orderIds), isNotNull(orders.paymentStatus)))
    .orderBy(orders.orderNo);
  return rows.map((row) => row.orderNo);
}

// ---------- Order summary (for the printed card's own text) ----------

export interface OrderSummaryForCard {
  orderId: string;
  orderNo: string;
  customerName: string | null;
  buyerUsername: string | null;
}

export async function getOrderSummaryForCard(orderId: string, db: Database = defaultDb): Promise<OrderSummaryForCard | null> {
  const [row] = await db
    .select({
      orderId: orders.id,
      orderNo: orders.orderNo,
      customerName: orderBuyerNameSql(),
      buyerUsername: orders.buyerUsername,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  return row ?? null;
}

// ---------- Mint (print / reprint) ----------

export interface MintedCard {
  cardId: string;
  orderId: string;
  token: string;
  claimDeadline: Date;
  wasReprint: boolean;
}

/** Prints (or reprints) a thank-you card for one order — mints a fresh, unguessable token,
 * stores only its hash (docs/SPEC.md §4.2), and voids whatever active card already existed for
 * this order (reprint = rotate, the old token can never validate again). Returns the RAW token
 * ONCE, transiently — it is never persisted anywhere, only used immediately by the caller to
 * render the QR/printed fallback text.
 *
 * `.for("update")` on the order row is the SAME lock `transitionOrderStatus` takes
 * (lib/orders/queries.ts) — this is what makes "mint a card" and "cancel this order" (which
 * voids its active card) mutually exclusive on the same order, closing the race where a
 * concurrent reprint could mint a brand-new active card for an order that a cancellation just
 * voided the previous one for. */
export async function mintThankYouCard(orderId: string, actorStaffUserId: string, db: Database = defaultDb): Promise<MintedCard> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new ActionError("Pesanan tidak ditemukan.");
    if (order.status === "cancelled" || order.status === "returned") {
      throw new ActionError("Pesanan ini sudah dibatalkan/diretur, tidak bisa mencetak kartu.");
    }
    // Thank-you cards are for marketplace buyers (SPEC §4.1); a web checkout order is already on the
    // main site (docs/plans/cart-checkout.md §7, enforced here, not only by the packing UI). Manual
    // orders keep printing as before.
    if (order.paymentStatus !== null) {
      throw new ActionError(`${order.orderNo} adalah pesanan dari website dan tidak memakai kartu terima kasih.`);
    }

    const [existingActive] = await tx
      .select()
      .from(thankYouCards)
      .where(and(eq(thankYouCards.orderId, orderId), eq(thankYouCards.status, "active")))
      .limit(1);

    if (existingActive) {
      await tx.update(thankYouCards).set({ status: "void" }).where(eq(thankYouCards.id, existingActive.id));
    }

    const token = generateClaimToken();
    const claimDeadline = claimDeadlineFromOrderDate(order.orderDate);
    const [card] = await tx
      .insert(thankYouCards)
      .values({ orderId, tokenHash: hashClaimToken(token), claimDeadline, printedByStaffUserId: actorStaffUserId })
      .returning();
    if (!card) throw new Error("failed to insert thank_you_card");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: existingActive ? "reprint" : "print",
      entityType: "thank_you_card",
      entityId: card.id,
      before: existingActive ?? undefined,
      after: card,
    });

    return { cardId: card.id, orderId, token, claimDeadline, wasReprint: Boolean(existingActive) };
  });
}

export interface MintedCardForBatch {
  orderId: string;
  orderNo: string;
  buyerName: string;
  token: string;
  claimDeadline: Date;
  stickerCode: string;
  wasReprint: boolean;
}

/** The one mint entry point BOTH print paths share (docs/plans/thermal-stickers.md: "printing
 * stickers counts as printing the card" — the owner's own requirement that this never fork into
 * two different minting code paths). Mints/rotates every order's card via the existing
 * `mintThankYouCard` (unchanged), then — in the SAME transaction — computes and persists each
 * new card's sticker code: `fixed` is every OTHER `to_ship` order's already-persisted code
 * (this batch's own old codes, if any, are excluded since they're being replaced right now),
 * `pending` is this batch's own orders, so a collision against either is caught and widened
 * before anything commits. Returns everything either caller (`printThankYouCardsAction`,
 * `printStickerSheetsAction`) needs — the SVG-vs-PDF rendering is the only thing that differs
 * downstream. */
export async function mintThankYouCardsForOrders(orderIds: string[], staffUserId: string, tx: Tx): Promise<MintedCardForBatch[]> {
  const dedupedOrderIds = [...new Set(orderIds)];

  const minted: { orderId: string; orderNo: string; buyerName: string; cardId: string; token: string; claimDeadline: Date; wasReprint: boolean }[] = [];
  for (const orderId of dedupedOrderIds) {
    const order = await getOrderSummaryForCard(orderId, tx);
    if (!order) throw new ActionError(`Pesanan ${orderId} tidak ditemukan.`);
    const result = await mintThankYouCard(orderId, staffUserId, tx);
    minted.push({
      orderId,
      orderNo: order.orderNo,
      buyerName: resolveCardBuyerName(order),
      cardId: result.cardId,
      token: result.token,
      claimDeadline: result.claimDeadline,
      wasReprint: result.wasReprint,
    });
  }

  const [pendingInputs, fixedEntries] = await Promise.all([
    getStickerCodeInputsForOrders(dedupedOrderIds, tx),
    getFixedStickerCodesForToShipQueue(dedupedOrderIds, tx),
  ]);
  const codeByOrderId = assignStickerCodes(pendingInputs, fixedEntries);

  const results: MintedCardForBatch[] = [];
  for (const m of minted) {
    const stickerCode = codeByOrderId.get(m.orderId);
    if (!stickerCode) throw new Error(`no sticker code computed for order ${m.orderId}`);
    await tx.update(thankYouCards).set({ stickerCode }).where(eq(thankYouCards.id, m.cardId));
    results.push({
      orderId: m.orderId,
      orderNo: m.orderNo,
      buyerName: m.buyerName,
      token: m.token,
      claimDeadline: m.claimDeadline,
      stickerCode,
      wasReprint: m.wasReprint,
    });
  }
  return results;
}
