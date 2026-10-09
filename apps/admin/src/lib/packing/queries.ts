import "server-only";
import { and, asc, count, eq, inArray } from "drizzle-orm";
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
import type { ChannelId } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { buildImageSizeUrl } from "@/lib/products/image-queries";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { generateClaimToken, hashClaimToken } from "./token";

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
}

export interface PackingPickListItem {
  orderId: string;
  sku: string;
  productName: string;
  colorName: string;
  size: string;
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
    .select({ orderId: thankYouCards.orderId, printedAt: thankYouCards.createdAt })
    .from(thankYouCards)
    .where(eq(thankYouCards.status, "active"))
    .as("active_card");

  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channels.name,
      customerName: customers.name,
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      cardPrintedAt: activeCard.printedAt,
    })
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(activeCard, eq(activeCard.orderId, orders.id))
    .where(where)
    .orderBy(asc(orders.orderDate), asc(orders.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const orderIds = rows.map((row) => row.id);
  const items = orderIds.length > 0 ? await listPickListItems(orderIds, db) : new Map<string, PackingPickListItem[]>();

  return { rows, items, pagination };
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
      customerName: customers.name,
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
      throw new ActionError("Pesanan ini sudah dibatalkan/diretur — tidak bisa mencetak kartu.");
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

/** Voids an order's active thank-you card, if it has one — called from
 * `transitionOrderStatus` (lib/orders/queries.ts) in the SAME transaction as a cancelled/
 * returned transition, so a card is never left `active` for an order that no longer is.
 * Already-`claimed` cards (and the voucher they issued) are never touched here — the owner
 * decides that policy separately (docs/plans/packing-cards.md). No-op (returns `null`) when
 * there's no active card to void, so callers don't need their own existence check first. */
export async function voidActiveCardForOrder(
  tx: Tx,
  orderId: string,
  actorStaffUserId: string | null,
): Promise<{ id: string } | null> {
  const [voided] = await tx
    .update(thankYouCards)
    .set({ status: "void" })
    .where(and(eq(thankYouCards.orderId, orderId), eq(thankYouCards.status, "active")))
    .returning();
  if (!voided) return null;

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "void",
    entityType: "thank_you_card",
    entityId: voided.id,
    after: voided,
  });
  return { id: voided.id };
}
