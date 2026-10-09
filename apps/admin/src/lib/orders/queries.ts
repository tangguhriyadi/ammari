import "server-only";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  channels,
  customers,
  fabricColors,
  orderItems,
  orders,
  products,
  productVariants,
  staffUsers,
  stockMovements,
  MARKETPLACE_CHANNEL_IDS,
} from "@ammari/db/schema";
import type { ChannelId, OrderStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { valueDeltaForConsumption } from "@/lib/inventory/moving-average";
import { lockVariantForUpdate } from "@/lib/stock/db";
import { currentBalanceForSkuLocked } from "@/lib/stock/queries";
import { ActionError, FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { generateOrderNumber } from "./order-number";
import { canTransitionOrderStatus, ORDER_STATUS_TIMESTAMP_COLUMN, STOCK_NOT_YET_DECREMENTED_STATUSES } from "./status";
// Cross-feature, one-directional (packing/queries.ts never imports anything from here) — thank-
// you-card lifecycle lives in lib/packing per docs/plans/packing-cards.md; a cancelled/returned
// order voiding its own active card is this function's job, not packing's, since packing has no
// other reason to ever be called FROM a status transition.
import { voidActiveCardForOrder } from "@/lib/packing/queries";

// ---------- Channels ----------

export interface ChannelOption {
  id: ChannelId;
  name: string;
}

export async function listChannels(db: Database = defaultDb): Promise<ChannelOption[]> {
  const rows = await db.select({ id: channels.id, name: channels.name }).from(channels).orderBy(channels.name);
  return rows;
}

// ---------- SKU picker (order items by SKU) ----------

export interface OrderableVariantRow {
  sku: string;
  size: string;
  productId: string;
  productName: string;
  colorId: string;
  colorName: string;
  colorHex: string | null;
  /** priceOverrideAmount ?? the product's basePrice — the same "effective price" every other
   * price-reading call site in this codebase computes inline (there is no shared helper to
   * reuse; see products/queries.ts's own variant rows). Prefilled into the order form, editable
   * per line before submit. */
  effectivePrice: number;
}

/** Active variants across every product — the /orders/new SKU picker's source list. Flat rows,
 * grouped product -> color -> size client-side, same division of labor as production's
 * listEligibleSkusForFabric/BatchLinePicker. */
export async function listOrderableVariants(db: Database = defaultDb): Promise<OrderableVariantRow[]> {
  const rows = await db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      productId: products.id,
      productName: products.name,
      colorId: fabricColors.id,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      priceOverrideAmount: productVariants.priceOverrideAmount,
      basePrice: products.basePrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.isActive, true))
    .orderBy(products.name, fabricColors.name, productVariants.size);

  return rows.map(({ priceOverrideAmount, basePrice, ...row }) => ({
    ...row,
    effectivePrice: priceOverrideAmount ?? basePrice,
  }));
}

// ---------- Create (manual entry) ----------

export interface CreateOrderItemInput {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface CreateOrderInput {
  channelId: ChannelId;
  /** Required for MARKETPLACE_CHANNEL_IDS (shopee/tiktok) — validated below, not by the DB
   * column itself (which is nullable so manual-entry channels can omit it) — so a future
   * importer's re-import of the same marketplace order always has a value to upsert against
   * `orders_channel_id_channel_order_no_key`, never silently inserting a duplicate. */
  channelOrderNo?: string | null;
  /** "YYYY-MM-DD", interpreted as that calendar date in Asia/Jakarta (fixed UTC+7, no DST). */
  orderDate: string;
  customerId?: string | null;
  buyerUsername?: string | null;
  shippingAddress?: string | null;
  notes?: string | null;
  items: readonly CreateOrderItemInput[];
  discountAmount: number;
  shippingAmount: number;
  /** Manual entry only ever starts an order here — `shipped`/`completed`/`cancelled`/`returned`
   * are reached exclusively through transitionOrderStatus afterward (see status.ts's doc
   * comment), never set directly at creation. */
  status: "awaiting_payment" | "to_ship";
}

/** "YYYY-MM-DD" (Asia/Jakarta, a fixed UTC+7 offset with no DST) -> the UTC instant of that
 * date's midnight in Jakarta. No Intl formatting needed (unlike today-in-Jakarta helpers that
 * must read the CURRENT time): a fixed offset literal in the ISO string is exact. */
function jakartaMidnightUtc(dateString: string): Date {
  return new Date(`${dateString}T00:00:00+07:00`);
}

const ORDER_CONSTRAINT_FIELDS = {
  orders_channel_id_channel_order_no_key: {
    field: "channelOrderNo",
    message: "Nomor pesanan ini sudah tercatat untuk kanal yang sama.",
  },
};

/** Inserts one `sale` stock_movements row per item (sorted by SKU, each locked first — same
 * deadlock-avoidance idiom as stock/queries.ts's saveStockCount) and snapshots the resulting
 * per-pcs cost onto that order_item's `unit_cost` — called both from createOrder (when the
 * order starts already past awaiting_payment) and from transitionOrderStatus's
 * awaiting_payment -> to_ship path. Throws a FieldError named after the specific SKU that would
 * go negative, never a generic "stock tidak cukup". */
async function decrementStockForOrderItems(
  tx: Tx,
  items: readonly { id: string; sku: string; qty: number }[],
  actorStaffUserId: string | null,
): Promise<void> {
  const sorted = [...items].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  for (const item of sorted) {
    await lockVariantForUpdate(tx, item.sku);
    const balance = await currentBalanceForSkuLocked(tx, item.sku);
    if (balance.qty - item.qty < 0) {
      throw new FieldError(item.sku, `Stok SKU ${item.sku} tidak cukup (tersisa ${balance.qty}).`);
    }
    const valueAmount = valueDeltaForConsumption(balance, -item.qty);
    await tx.insert(stockMovements).values({
      sku: item.sku,
      qty: -item.qty,
      valueAmount,
      type: "sale",
      refType: "order_item",
      refId: item.id,
      createdByStaffUserId: actorStaffUserId,
    });
    // unit_cost is locked at this exact moment (order_items' own doc comment) — never
    // recomputed later even if the SKU's average cost moves afterward.
    await tx
      .update(orderItems)
      .set({ unitCost: Math.round(-valueAmount / item.qty) })
      .where(eq(orderItems.id, item.id));
  }
}

/** The exact-reversal counterpart to decrementStockForOrderItems — one `return` row per item,
 * whole-item only (full original qty, never partial), valued at the EXACT negation of that
 * item's own earlier `sale` row (never recomputed at whatever the average happens to be now —
 * same idiom as accessory_movements' purchase_void). No row lock needed here: unlike a
 * decrease, this never branches on the SKU's current balance, so there's nothing for a
 * concurrent writer to race against — the inserted row is a pure function of the order_item and
 * its own original sale movement. If the item is later found damaged, staff record that
 * separately via "Sesuaikan stok -> rusak" (adjustStock) — a return never assumes damage. */
async function restoreStockForOrderItems(tx: Tx, orderId: string, actorStaffUserId: string | null): Promise<void> {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const item of items) {
    const [saleMovement] = await tx
      .select({ valueAmount: stockMovements.valueAmount })
      .from(stockMovements)
      .where(and(eq(stockMovements.type, "sale"), eq(stockMovements.refType, "order_item"), eq(stockMovements.refId, item.id)));
    if (!saleMovement) throw new Error(`order_item ${item.id} has no matching sale movement to reverse`);
    await tx.insert(stockMovements).values({
      sku: item.sku,
      qty: item.qty,
      valueAmount: -saleMovement.valueAmount,
      type: "return",
      refType: "order_item",
      refId: item.id,
      createdByStaffUserId: actorStaffUserId,
    });
  }
}

function validateOrderItemsInput(items: readonly CreateOrderItemInput[]): void {
  if (items.length === 0) throw new ActionError("Pesanan harus punya minimal 1 item.");
  const seen = new Set<string>();
  for (const item of items) {
    if (item.qty <= 0) throw new FieldError(item.sku, `Jumlah untuk SKU ${item.sku} harus lebih dari 0.`);
    if (item.unitPrice < 0) throw new FieldError(item.sku, `Harga untuk SKU ${item.sku} tidak boleh negatif.`);
    if (seen.has(item.sku)) throw new FieldError(item.sku, `SKU ${item.sku} muncul lebih dari sekali dalam pesanan ini.`);
    seen.add(item.sku);
  }
}

export async function createOrder(input: CreateOrderInput, actorStaffUserId: string, db: Database = defaultDb) {
  validateOrderItemsInput(input.items);
  if (MARKETPLACE_CHANNEL_IDS.includes(input.channelId) && !input.channelOrderNo?.trim()) {
    throw new FieldError("channelOrderNo", "Nomor pesanan marketplace wajib diisi untuk kanal ini.");
  }
  if (input.discountAmount < 0) throw new FieldError("discountAmount", "Diskon tidak boleh negatif.");
  if (input.shippingAmount < 0) throw new FieldError("shippingAmount", "Ongkos kirim tidak boleh negatif.");

  const subtotalAmount = input.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const totalAmount = subtotalAmount + input.shippingAmount - input.discountAmount;
  if (totalAmount < 0) throw new ActionError("Total pesanan tidak boleh negatif — periksa diskon.");

  return db.transaction(async (tx) => {
    try {
      const orderNo = await generateOrderNumber(tx);
      const [order] = await tx
        .insert(orders)
        .values({
          channelId: input.channelId,
          orderNo,
          channelOrderNo: input.channelOrderNo?.trim() || null,
          status: input.status,
          customerId: input.customerId ?? null,
          buyerUsername: input.buyerUsername?.trim() || null,
          orderDate: jakartaMidnightUtc(input.orderDate),
          subtotalAmount,
          shippingAmount: input.shippingAmount,
          discountAmount: input.discountAmount,
          totalAmount,
          shippingAddress: input.shippingAddress?.trim() || null,
          notes: input.notes?.trim() || null,
          createdByStaffUserId: actorStaffUserId,
        })
        .returning();
      if (!order) throw new Error("failed to insert order");

      const insertedItems = await tx
        .insert(orderItems)
        .values(
          input.items.map((item) => ({
            orderId: order.id,
            sku: item.sku,
            qty: item.qty,
            unitPrice: item.unitPrice,
            // Placeholder — overwritten by decrementStockForOrderItems below whenever this
            // order's starting status already requires stock to leave. Stays 0 for an
            // awaiting_payment order, where stock hasn't left yet (set for real on its later
            // awaiting_payment -> to_ship transition).
            unitCost: 0,
          })),
        )
        .returning();

      if (!STOCK_NOT_YET_DECREMENTED_STATUSES.includes(order.status)) {
        await decrementStockForOrderItems(tx, insertedItems, actorStaffUserId);
      }

      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "order",
        entityId: order.id,
        after: { ...order, items: insertedItems },
      });

      return order;
    } catch (error) {
      mapUniqueViolation(error, ORDER_CONSTRAINT_FIELDS);
    }
  });
}

// ---------- Item edit lock (approved plan, rule 4) ----------

export interface UpdateOrderItemInput {
  sku: string;
  qty: number;
  unitPrice: number;
}

/** Order items are editable ONLY while status = 'awaiting_payment' (approved plan) — once stock
 * has left (to_ship and later), a line's qty/price is locked forever; the fix for a mistake is
 * cancel + recreate, never an in-place edit of a line that already has a stock/cost consequence.
 * Enforced here, server-side, as the one path any future "edit order" UI would have to go
 * through — not just a UI-level disabled state. Replaces the full item set (delete-all-reinsert,
 * same idiom production_batch_items' own draft-save already uses) since 'awaiting_payment' never
 * has a unit_cost snapshot to preserve (stock hasn't left yet). */
export async function updateOrderItems(
  orderId: string,
  items: readonly UpdateOrderItemInput[],
  actorStaffUserId: string,
  db: Database = defaultDb,
) {
  validateOrderItemsInput(items);
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new ActionError("Pesanan tidak ditemukan.");
    if (order.status !== "awaiting_payment") {
      throw new ActionError("Item pesanan hanya bisa diubah selama status masih menunggu bayar. Batalkan dan buat pesanan baru.");
    }

    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
    const insertedItems = await tx
      .insert(orderItems)
      .values(items.map((item) => ({ orderId, sku: item.sku, qty: item.qty, unitPrice: item.unitPrice, unitCost: 0 })))
      .returning();

    const subtotalAmount = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
    const totalAmount = subtotalAmount + order.shippingAmount - order.discountAmount;
    if (totalAmount < 0) throw new ActionError("Total pesanan tidak boleh negatif — periksa diskon.");

    const [updated] = await tx.update(orders).set({ subtotalAmount, totalAmount }).where(eq(orders.id, orderId)).returning();
    if (!updated) throw new Error("failed to update order");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update_items",
      entityType: "order",
      entityId: orderId,
      before: order,
      after: { ...updated, items: insertedItems },
    });
    return updated;
  });
}

// ---------- Status transitions ----------

export interface TransitionOrderStatusOptions {
  /** Only ever applied when `toStatus === "shipped"` — packing's bulk "Tandai dikirim" omits
   * both, a per-order one may set either or both. */
  courier?: string | null;
  trackingNumber?: string | null;
}

/** The ONLY path allowed to move an order between statuses (status.ts's own doc comment) —
 * checks ORDER_STATUS_TRANSITIONS, stamps the matching timestamp column, and runs the matching
 * stock side effect (decrement on awaiting_payment -> to_ship; whole-item restore on any
 * cancellation/return of an order whose stock had already left), all in one transaction. A
 * cancelled/returned transition ALSO voids the order's active thank-you card in this same
 * transaction (docs/plans/packing-cards.md) — an already-`claimed` card/voucher is never
 * touched; that policy is the owner's to decide later. */
export async function transitionOrderStatus(
  orderId: string,
  toStatus: OrderStatus,
  actorStaffUserId: string,
  db: Database = defaultDb,
  options: TransitionOrderStatusOptions = {},
) {
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE — without this, two concurrent transitions on the SAME order (two
    // tabs, or a double-click racing a slow first request) both read the same fromStatus, both
    // pass canTransitionOrderStatus, and both proceed: a check-then-write race CLAUDE.md
    // forbids. This lock serializes them so the second one re-reads the ALREADY-updated status
    // before deciding anything (same idiom lockVariantForUpdate uses for stock).
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new ActionError("Pesanan tidak ditemukan.");

    const fromStatus = order.status;
    if (!canTransitionOrderStatus(fromStatus, toStatus)) {
      throw new ActionError(`Pesanan dengan status ini tidak bisa diubah ke status tersebut.`);
    }

    if (fromStatus === "awaiting_payment" && toStatus === "to_ship") {
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      await decrementStockForOrderItems(tx, items, actorStaffUserId);
    } else if (toStatus === "cancelled" || toStatus === "returned") {
      if (!STOCK_NOT_YET_DECREMENTED_STATUSES.includes(fromStatus)) {
        await restoreStockForOrderItems(tx, orderId, actorStaffUserId);
      }
      // Same transaction as the status change itself — an active card must never outlive the
      // order it was printed for (docs/plans/packing-cards.md). No-op if there isn't one.
      await voidActiveCardForOrder(tx, orderId, actorStaffUserId);
    }

    const timestampColumn = (ORDER_STATUS_TIMESTAMP_COLUMN as Record<string, string>)[toStatus];
    // courier/trackingNumber are only ever meaningful alongside the shipped transition itself —
    // never set (or overwritten) by any other transition, even if a caller passed them by
    // mistake on e.g. a "completed" transition.
    const shippingFields =
      toStatus === "shipped" ? { courier: options.courier ?? null, trackingNumber: options.trackingNumber ?? null } : {};
    // WHERE status = fromStatus, not just id — a second concurrent caller that somehow still
    // reached this point with a stale fromStatus (defense in depth beyond the row lock above)
    // updates zero rows instead of silently overwriting a status it never actually validated.
    const [updated] = await tx
      .update(orders)
      .set({ status: toStatus, ...(timestampColumn ? { [timestampColumn]: new Date() } : {}), ...shippingFields })
      .where(and(eq(orders.id, orderId), eq(orders.status, fromStatus)))
      .returning();
    if (!updated) throw new ActionError("Status pesanan sudah berubah — muat ulang halaman.");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "transition_status",
      entityType: "order",
      entityId: orderId,
      before: order,
      after: updated,
    });
    return updated;
  });
}

// ---------- Read ----------

export interface OrderListRow {
  id: string;
  orderNo: string;
  channelId: string;
  channelName: string;
  channelOrderNo: string | null;
  status: OrderStatus;
  customerName: string | null;
  buyerUsername: string | null;
  orderDate: Date;
  totalAmount: number;
  createdAt: Date;
}

export interface ListOrdersFilters {
  status?: OrderStatus;
  q?: string;
}

export async function listOrders(
  filters: ListOrdersFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: OrderListRow[]; pagination: Pagination }> {
  const conditions = [
    filters.status ? eq(orders.status, filters.status) : undefined,
    filters.q
      ? or(ilike(orders.orderNo, `%${filters.q}%`), ilike(orders.channelOrderNo, `%${filters.q}%`), ilike(customers.name, `%${filters.q}%`))
      : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: sql<number>`count(*)::int` })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channels.name,
      channelOrderNo: orders.channelOrderNo,
      status: orders.status,
      customerName: customers.name,
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

export interface OrderItemRow {
  id: string;
  sku: string;
  productName: string;
  colorName: string;
  size: string;
  qty: number;
  unitPrice: number;
  /** `null` when stripped for a viewer without finance.view_profit (see stripOrderItemCost) —
   * never `null` because the value is genuinely unknown. */
  unitCost: number | null;
}

export interface OrderDetail {
  id: string;
  orderNo: string;
  channelId: string;
  channelName: string;
  channelOrderNo: string | null;
  status: OrderStatus;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  buyerUsername: string | null;
  orderDate: Date;
  shippedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  returnedAt: Date | null;
  subtotalAmount: number;
  shippingAmount: number;
  discountAmount: number;
  totalAmount: number;
  shippingAddress: string | null;
  notes: string | null;
  createdByName: string | null;
  createdAt: Date;
  items: OrderItemRow[];
}

export async function getOrderDetail(id: string, db: Database = defaultDb): Promise<OrderDetail | null> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channels.name,
      channelOrderNo: orders.channelOrderNo,
      status: orders.status,
      customerId: orders.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      shippedAt: orders.shippedAt,
      completedAt: orders.completedAt,
      cancelledAt: orders.cancelledAt,
      returnedAt: orders.returnedAt,
      subtotalAmount: orders.subtotalAmount,
      shippingAmount: orders.shippingAmount,
      discountAmount: orders.discountAmount,
      totalAmount: orders.totalAmount,
      shippingAddress: orders.shippingAddress,
      notes: orders.notes,
      createdByName: staffUsers.name,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(staffUsers, eq(staffUsers.id, orders.createdByStaffUserId))
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) return null;

  const itemRows = await db
    .select({
      id: orderItems.id,
      sku: orderItems.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
      unitCost: orderItems.unitCost,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(orderItems.orderId, id))
    .orderBy(orderItems.createdAt);

  return { ...order, items: itemRows };
}

/** Cost data (unit_cost) is gated by finance.view_profit, same discipline every other cost field
 * in this codebase follows (see lib/inventory/purchases.ts's stripPurchaseAmount) — stripped
 * server-side, never left to the client to hide. */
export function stripOrderDetailCost(detail: OrderDetail, canViewProfit: boolean): OrderDetail {
  if (canViewProfit) return detail;
  return { ...detail, items: detail.items.map((item) => ({ ...item, unitCost: null })) };
}
