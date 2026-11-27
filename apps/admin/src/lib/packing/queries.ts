import "server-only";
import { and, asc, count, eq, inArray, isNotNull, not, notInArray } from "drizzle-orm";
import {
  channels,
  customers,
  fabricColors,
  orderItems,
  orders,
  productImages,
  products,
  productVariants,
  shipments,
  thankYouCards,
  tiktokOrders,
} from "@ammari/db/schema";
import type { ChannelId, ShipmentStatus, Size } from "@ammari/db/schema";
import { orderBuyerNameSql } from "@/lib/orders/buyer-name";
import { tiktokPackingState, type TikTokPackingState } from "@ammari/commerce/tiktok";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { buildImageSizeUrl } from "@/lib/products/image-queries";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { channelDisplayNameSql } from "@/lib/orders/channel-label";
import { generateClaimToken, hashClaimToken } from "./token";
import { takesThankYouCardSql } from "./card-eligibility";
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
  /** A web checkout order (`payment_status` set, docs/plans/cart-checkout.md §7): staff book
   * `shippingServiceLabel` and ship it with a resi, one by one. */
  isCheckout: boolean;
  /** Whether this order takes a thank-you card (card-eligibility.ts): every manual/marketplace
   * order, and a web checkout order only as a guest's first website purchase (SPEC §4.1). */
  takesCard: boolean;
  /** The quoted courier service locked on a checkout order (e.g. "JNE Reguler"); null otherwise. */
  shippingServiceLabel: string | null;
  /** The order's live courier booking (Phase K2: "Pesan kurir"), if any. */
  shipment: { status: ShipmentStatus; awb: string | null; providerStatus: string | null } | null;
  /** A TikTok order applied by the sync (docs/plans/tiktok-shop-integration.md §4.4, T5): its packing
   * gate (only `ready` may be packed and shipped) and the buyer's note (Q14). Null otherwise. */
  tiktok: { packing: TikTokPackingState; buyerMessage: string | null; rtsSlaTime: Date | null } | null;
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

  // Sticker-code preview (docs/plans/thermal-stickers.md): scoped to the WHOLE to_ship queue —
  // never just this page, and never narrowed by `filters.channelId` either — a collision between
  // two orders must be caught even if the staffer is currently looking at a single-channel
  // filtered view that only shows one of them. Orders that already have an active card show
  // their PERSISTED code instead (never recomputed here); only genuinely unprinted orders need a
  // preview. Independent of the page's rows, so it runs alongside the count
  // (docs/plans/admin-performance.md).
  const stickerInputs = Promise.all([
    getUnprintedToShipOrderIds(db).then((unprintedOrderIds) => getStickerCodeInputsForOrders(unprintedOrderIds, db)),
    getFixedStickerCodesForToShipQueue([], db),
  ]);
  const [[totalCountRow], [previewInputs, fixedEntries]] = await Promise.all([
    db.select({ totalCount: count() }).from(orders).where(where),
    stickerInputs,
  ]);
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

  // At most one live attempt per order (shipments_live_order_id_key).
  const liveShipment = db
    .select({ orderId: shipments.orderId, status: shipments.status, awb: shipments.awb, providerStatus: shipments.providerStatus })
    .from(shipments)
    .where(notInArray(shipments.status, ["cancelled", "failed"]))
    .as("live_shipment");

  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channelDisplayNameSql(channels.id, channels.name),
      customerName: orderBuyerNameSql(),
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      cardPrintedAt: activeCard.printedAt,
      cardClaimedAt: claimedCard.claimedAt,
      persistedStickerCode: activeCard.stickerCode,
      paymentStatus: orders.paymentStatus,
      takesCard: takesThankYouCardSql(),
      shippingServiceLabel: orders.shippingCourierLabel,
      shipmentStatus: liveShipment.status,
      shipmentAwb: liveShipment.awb,
      shipmentProviderStatus: liveShipment.providerStatus,
      tiktokStatus: tiktokOrders.status,
      tiktokIsOnHoldOrder: tiktokOrders.isOnHoldOrder,
      tiktokPaidTime: tiktokOrders.paidTime,
      tiktokBuyerMessage: tiktokOrders.buyerMessage,
      tiktokRtsSlaTime: tiktokOrders.rtsSlaTime,
    })
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(activeCard, eq(activeCard.orderId, orders.id))
    .leftJoin(claimedCard, eq(claimedCard.orderId, orders.id))
    .leftJoin(liveShipment, eq(liveShipment.orderId, orders.id))
    .leftJoin(tiktokOrders, eq(tiktokOrders.orderId, orders.id))
    .where(where)
    .orderBy(asc(orders.orderDate), asc(orders.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const orderIds = rows.map((row) => row.id);
  const items = orderIds.length > 0 ? await listPickListItems(orderIds, db) : new Map<string, PackingPickListItem[]>();

  const previewMap = assignStickerCodes(previewInputs, fixedEntries);

  const now = new Date();
  const rowsWithStickerCodes: PackingQueueRow[] = rows.map(({ persistedStickerCode, paymentStatus, shipmentStatus, shipmentAwb, shipmentProviderStatus, tiktokStatus, tiktokIsOnHoldOrder, tiktokPaidTime, tiktokBuyerMessage, tiktokRtsSlaTime, ...row }) => {
    const isPrinted = row.cardPrintedAt !== null;
    const isCheckout = paymentStatus !== null;
    // An order whose card is already printed or claimed keeps showing it even if the rule would no
    // longer pick it today (e.g. an earlier paid order of the same email was reopened).
    const takesCard = row.takesCard || isPrinted || row.cardClaimedAt !== null;
    return {
      ...row,
      takesCard,
      // An order that takes no card has no sticker code either.
      stickerCode: !takesCard ? null : isPrinted ? persistedStickerCode : (previewMap.get(row.id) ?? null),
      stickerCodeIsPreview: takesCard && !isPrinted,
      isCheckout,
      shipment: shipmentStatus ? { status: shipmentStatus, awb: shipmentAwb, providerStatus: shipmentProviderStatus } : null,
      tiktok:
        tiktokStatus !== null
          ? { packing: tiktokPackingState({ status: tiktokStatus, isOnHoldOrder: tiktokIsOnHoldOrder, paidTime: tiktokPaidTime }, now), buyerMessage: tiktokBuyerMessage, rtsSlaTime: tiktokRtsSlaTime }
          : null,
    };
  });

  return { rows: rowsWithStickerCodes, items, pagination };
}

/** Every `to_ship` order with NO active thank-you card — the "pending" set for the sticker-code
 * preview (docs/plans/thermal-stickers.md): these are the orders whose code could still change
 * before they're actually printed. Orders that take no card (card-eligibility.ts) are not in it. */
async function getUnprintedToShipOrderIds(db: Database): Promise<string[]> {
  const activeCardOrderIds = db.select({ orderId: thankYouCards.orderId }).from(thankYouCards).where(eq(thankYouCards.status, "active"));
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "to_ship"), takesThankYouCardSql(), notInArray(orders.id, activeCardOrderIds)));
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
 * "Tandai dikirim" warning. Orders that take no card (card-eligibility.ts) never need one. */
export async function getOrdersMissingCard(orderIds: string[], db: Database = defaultDb): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const [status, noCardRows] = await Promise.all([
    getCardPrintStatus(orderIds, db),
    db.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, orderIds), not(takesThankYouCardSql()))),
  ]);
  const noCard = new Set(noCardRows.map((row) => row.id));
  return orderIds.filter((id) => !noCard.has(id) && status.get(id) === false);
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

/** The order numbers of the TikTok orders among `orderIds` that may not be shipped yet (the packing
 * gate, docs/plans/tiktok-shop-integration.md §4.4): bulk "Tandai dikirim" refuses the whole
 * selection before anything ships. transitionOrderStatus enforces the same gate per order. */
export async function getTikTokNotPackableOrderNos(orderIds: string[], db: Database = defaultDb, now: Date = new Date()): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .select({ orderNo: orders.orderNo, status: tiktokOrders.status, isOnHoldOrder: tiktokOrders.isOnHoldOrder, paidTime: tiktokOrders.paidTime })
    .from(orders)
    .innerJoin(tiktokOrders, eq(tiktokOrders.orderId, orders.id))
    .where(inArray(orders.id, orderIds))
    .orderBy(orders.orderNo);
  return rows.filter((row) => tiktokPackingState(row, now).kind !== "ready").map((row) => row.orderNo);
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
    // Thank-you cards are for marketplace and manual orders, and for a guest's first website
    // purchase only (SPEC §4.1, card-eligibility.ts: the same rule the packing list shows, enforced
    // here, not only by the packing UI). The row lock above covers only this order; two orders of
    // one email minting at once still agree, since the earliest-paid tie-break is deterministic.
    const [eligibility] = await tx.select({ takesCard: takesThankYouCardSql() }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!eligibility?.takesCard) {
      throw new ActionError(
        `${order.orderNo} adalah pesanan website yang tidak mendapat kartu terima kasih (kartu hanya untuk pembelian pertama pembeli tanpa akun).`,
      );
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
