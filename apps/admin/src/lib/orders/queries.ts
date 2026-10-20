import "server-only";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { channels, customers, fabricColors, orderItems, orders, products, productVariants, staffUsers, thankYouCards } from "@ammari/db/schema";
import type { ChannelId, OrderStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";

// Read-only, admin-screen queries (channel list, SKU picker, order list/detail). The order WRITE
// path (createOrder, updateOrderItems, transitionOrderStatus, generateOrderNumber) lives in
// @ammari/commerce/orders (docs/plans/cart-checkout.md D1) so web checkout, the payment webhook
// and admin all share one transitionOrderStatus.

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
  /** `null` = no card claimed (yet, or ever) for this order. Set once a buyer claims the
   * thank-you card's voucher on the main site (apps/web's `/claim/[token]`, docs/plans/
   * voucher-claim.md session 2). */
  cardClaimedAt: Date | null;
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

  // At most one claimed card normally exists per order (voidActiveCardForOrder/mintThankYouCard
  // never touch an already-claimed card), but `desc(claimedAt).limit(1)` is defensive rather
  // than assuming that invariant holds forever.
  const [claimedCard] = await db
    .select({ claimedAt: thankYouCards.claimedAt })
    .from(thankYouCards)
    .where(and(eq(thankYouCards.orderId, id), eq(thankYouCards.status, "claimed")))
    .orderBy(desc(thankYouCards.claimedAt))
    .limit(1);

  return { ...order, items: itemRows, cardClaimedAt: claimedCard?.claimedAt ?? null };
}

/** Cost data (unit_cost) is gated by finance.view_profit, same discipline every other cost field
 * in this codebase follows (see lib/inventory/purchases.ts's stripPurchaseAmount) — stripped
 * server-side, never left to the client to hide. */
export function stripOrderDetailCost(detail: OrderDetail, canViewProfit: boolean): OrderDetail {
  if (canViewProfit) return detail;
  return { ...detail, items: detail.items.map((item) => ({ ...item, unitCost: null })) };
}
