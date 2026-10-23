import "server-only";
import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { channels, fabricColors, orderItems, orders, payments, products, productVariants, shipmentEvents, shipments } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import { formatJakartaDate, formatJakartaDateTime } from "@/lib/format";
import { isSafePaymentUrl } from "@/lib/checkout/navigate";
import { siteOrigin } from "@/lib/site-origin";
import { customerOrderStatus, type CustomerOrderStatus } from "./status";
import { visibleToCustomerSql } from "./access";
import { snapshotListLineTotal, snapshotSavings } from "./line-savings";
import { BUYER_TRACKING_MAX_EVENTS, buyerTracking, type BuyerTracking } from "./tracking";

// Reads for "Pesanan saya" (`/orders`, `/orders/[orderNo]`, the /account list; docs/plans/
// cart-checkout.md §9.1). Customer-facing: no cost column is ever selected (order_items.unit_cost
// stays out; the locked ongkir quote's courier cost and subsidy are the buyer's own checkout figures
// and are shown since the 2026-10-21 sandbox run), nothing returns a stock number, and who may see
// which order is decided by ./access.ts before anything here runs.

export const ORDERS_PAGE_SIZE = 10;

export interface CustomerOrderItem {
  name: string;
  /** "Beige · M". */
  variant: string;
  qty: number;
}

export interface CustomerOrderRow {
  orderNo: string;
  /** "21 Oktober 2026" (WIB). */
  orderedOn: string;
  channelName: string;
  /** A storefront checkout order (it has a payment status and totals the buyer paid). */
  isCheckout: boolean;
  status: CustomerOrderStatus;
  /** Checkout orders only: what the buyer pays, ongkir included. */
  total: number | null;
  items: CustomerOrderItem[];
}

export interface CustomerOrderPage {
  rows: CustomerOrderRow[];
  page: number;
  pageCount: number;
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

const listColumns = {
  id: orders.id,
  orderNo: orders.orderNo,
  orderDate: orders.orderDate,
  channelName: channels.name,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  total: orders.totalAmount,
  paymentWindowOpen: sql<boolean>`coalesce(${orders.paymentExpiresAt} > now(), false)`,
};

/** The customer's orders, newest first, `pageSize` per page (a page past the end is the last
 * page). */
export async function listCustomerOrders(customerId: string, requestedPage: number, db: Database = defaultDb, pageSize = ORDERS_PAGE_SIZE): Promise<CustomerOrderPage> {
  const visible = visibleToCustomerSql(customerId);
  const [counted] = await db.select({ n: count() }).from(orders).where(visible);
  const pageCount = Math.max(1, Math.ceil((counted?.n ?? 0) / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const rows = await db
    .select(listColumns)
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .where(visible)
    .orderBy(desc(orders.orderDate), desc(orders.orderNo))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = await itemsForOrders(rows.map((row) => row.id), db);
  return { rows: rows.map((row) => toRow(row, items.get(row.id) ?? [])), page, pageCount };
}

function toRow(row: { id: string; orderNo: string; orderDate: Date; channelName: string; status: string; paymentStatus: string | null; total: number; paymentWindowOpen: boolean }, items: readonly CustomerOrderItem[]): CustomerOrderRow {
  const isCheckout = row.paymentStatus !== null;
  return {
    orderNo: row.orderNo,
    orderedOn: formatJakartaDate(row.orderDate),
    channelName: row.channelName,
    isCheckout,
    status: customerOrderStatus(row),
    total: isCheckout ? row.total : null,
    items: items.map(({ name, variant, qty }) => ({ name, variant, qty })),
  };
}

type OrderItemSnapshot = CustomerOrderItem & { sku: string; unitPrice: number; listUnitPrice: number | null };

async function itemsForOrders(orderIds: string[], db: Database): Promise<Map<string, OrderItemSnapshot[]>> {
  const map = new Map<string, OrderItemSnapshot[]>();
  if (orderIds.length === 0) return map;
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      sku: orderItems.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
      listUnitPrice: orderItems.listUnitPrice,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.sku));
  for (const row of rows) {
    const list = map.get(row.orderId) ?? [];
    list.push({ sku: row.sku, name: row.productName, variant: `${row.colorName} · ${sizeLabel(row.size)}`, qty: row.qty, unitPrice: row.unitPrice, listUnitPrice: row.listUnitPrice });
    map.set(row.orderId, list);
  }
  return map;
}

/** Whether the order's lines (as read through the product joins) add up to its stored subtotal;
 * logs the gap when they do not. */
function linesAddUp(orderNo: string, items: readonly { qty: number; unitPrice: number }[], subtotal: number, where: string): boolean {
  const linesTotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  if (items.length > 0 && linesTotal === subtotal) return true;
  console.error(`[orders] ${where}: order lines do not add up to the order subtotal`, { orderNo, lines: items.length, linesTotal, subtotal });
  return false;
}

export interface CustomerOrderDetail extends CustomerOrderRow {
  /** `lineTotal` and `listLineTotal` (the struck normal price, when a product discount lowered the
   * line) are checkout orders only. */
  lines: (CustomerOrderItem & { sku: string; lineTotal: number | null; listLineTotal: number | null })[];
  /** Checkout orders only. `shipping` is the buyer's share of ongkir as paid; `shippingCost` and
   * `shippingSubsidy` the locked quote (courier cost, Ammari's subsidy). */
  totals: {
    subtotal: number;
    /** "Hemat": the product discounts on the lines (0 when none). */
    savings: number;
    shipping: number;
    shippingCost: number | null;
    shippingSubsidy: number | null;
    discount: number;
    total: number;
    courierLabel: string | null;
  } | null;
  /** The one-line address on the order (recipient, phone, street, area). */
  address: string | null;
  /** Milestones with a time, oldest first ("Dipesan", "Dibayar", ...), in WIB. */
  timeline: { label: string; at: string }[];
  /** "Lacak pengiriman": the courier and resi on the order ("Tandai dikirim", or the courier booking
   * once the parcel was picked up). */
  shipment: { courier: string | null; trackingNumber: string | null };
  /** The courier timeline of the order's current booking (Phase K4), latest first. */
  tracking: BuyerTracking;
  /** "21 Oktober 2026, 14.30 WIB", only while payable. */
  payBy: string | null;
  /** The stored payment page, only while payable; null when it could not be created. */
  paymentUrl: string | null;
}

/** One order for its page. Call only with an id ./access.ts returned for this visitor. */
export async function loadCustomerOrderDetail(orderId: string, db: Database = defaultDb): Promise<CustomerOrderDetail | null> {
  const [order] = await db
    .select({
      ...listColumns,
      subtotal: orders.subtotalAmount,
      shipping: orders.shippingAmount,
      shippingCost: orders.shippingCostAmount,
      shippingSubsidy: orders.shippingSubsidyAmount,
      discount: orders.discountAmount,
      courierLabel: orders.shippingCourierLabel,
      address: orders.shippingAddress,
      paymentExpiresAt: orders.paymentExpiresAt,
      paidAt: orders.paidAt,
      shippedAt: orders.shippedAt,
      completedAt: orders.completedAt,
      cancelledAt: orders.cancelledAt,
      returnedAt: orders.returnedAt,
      courier: orders.courier,
      trackingNumber: orders.trackingNumber,
    })
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  const items = (await itemsForOrders([order.id], db)).get(order.id) ?? [];
  const row = toRow(order, items);

  // A line lost by a join would show an order that does not add up: logged loudly (the totals shown
  // stay the stored ones).
  if (row.isCheckout) linesAddUp(order.orderNo, items, order.subtotal, "order page");

  let paymentUrl: string | null = null;
  if (row.status.payable) {
    const [payment] = await db
      .select({ redirectUrl: payments.redirectUrl })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.attempt))
      .limit(1);
    // Stored from the gateway's answer; still only an https page or this site is ever linked.
    const stored = payment?.redirectUrl ?? null;
    paymentUrl = stored && isSafePaymentUrl(stored, siteOrigin()) ? stored : null;
    if (!paymentUrl) console.error("[orders] payable order without a usable payment page", { orderNo: order.orderNo, stored: stored !== null });
  }

  const tracking = await loadBuyerTracking(order.id, order.status, order.trackingNumber, db);

  const milestones: [string, Date | null][] = [
    ["Dipesan", order.orderDate],
    ["Dibayar", order.paidAt],
    ["Dikirim", order.shippedAt],
    ["Selesai", order.completedAt],
    ["Dibatalkan", order.cancelledAt],
    ["Dikembalikan", order.returnedAt],
  ];

  return {
    ...row,
    lines: items.map(({ unitPrice, listUnitPrice, ...item }) => ({
      ...item,
      lineTotal: row.isCheckout ? item.qty * unitPrice : null,
      listLineTotal: row.isCheckout ? snapshotListLineTotal({ qty: item.qty, unitPrice, listUnitPrice }) : null,
    })),
    totals: row.isCheckout
      ? {
          subtotal: order.subtotal,
          savings: snapshotSavings(items),
          shipping: order.shipping,
          shippingCost: order.shippingCost,
          shippingSubsidy: order.shippingSubsidy,
          discount: order.discount,
          total: order.total,
          courierLabel: order.courierLabel,
        }
      : null,
    address: order.address,
    timeline: milestones.filter((entry): entry is [string, Date] => entry[1] !== null).sort((a, b) => a[1].getTime() - b[1].getTime()).map(([label, at]) => ({ label, at: formatJakartaDateTime(at) })),
    shipment: { courier: order.courier ?? (order.trackingNumber ? order.courierLabel : null), trackingNumber: order.trackingNumber },
    tracking,
    payBy: row.status.payable && order.paymentExpiresAt ? formatJakartaDateTime(order.paymentExpiresAt) : null,
    paymentUrl,
  };
}

/** The order's current courier booking (not cancelled or failed: an ended attempt was another
 * parcel) and its newest events, as ./tracking.ts shows them. Only the columns the buyer's view
 * needs: never the cost, the driver or the provider's ids. */
async function loadBuyerTracking(orderId: string, orderStatus: string, trackingNumber: string | null, db: Database): Promise<BuyerTracking> {
  const [shipment] = await db
    .select({
      id: shipments.id,
      awb: shipments.awb,
      status: shipments.status,
      lastError: shipments.lastError,
      staleFlaggedAt: shipments.staleFlaggedAt,
      lastEventAt: shipments.lastEventAt,
      bookedAt: shipments.bookedAt,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), notInArray(shipments.status, ["cancelled", "failed"])))
    .orderBy(desc(shipments.attempt))
    .limit(1);
  if (!shipment) return buyerTracking({ orderStatus, trackingNumber, shipment: null, events: [] });
  const events = await db
    .select({
      occurredAt: shipmentEvents.occurredAt,
      providerStatus: shipmentEvents.providerStatus,
      normalizedStatus: shipmentEvents.normalizedStatus,
      description: shipmentEvents.description,
      location: shipmentEvents.location,
    })
    .from(shipmentEvents)
    .where(eq(shipmentEvents.shipmentId, shipment.id))
    .orderBy(desc(shipmentEvents.occurredAt), desc(shipmentEvents.createdAt))
    .limit(BUYER_TRACKING_MAX_EVENTS);
  return buyerTracking({ orderStatus, trackingNumber, shipment, events });
}

/** "Pesan lagi": the SKUs and quantities of a cancelled, never-paid checkout order, or null when
 * the order is not one (the action refuses then). Call only with an id ./access.ts returned. */
export async function loadReorderLines(orderId: string, db: Database = defaultDb): Promise<(CustomerOrderItem & { sku: string })[] | null> {
  const [order] = await db
    .select({ orderNo: orders.orderNo, status: orders.status, paymentStatus: orders.paymentStatus, paymentWindowOpen: listColumns.paymentWindowOpen, subtotal: orders.subtotalAmount })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order || !customerOrderStatus(order).reorderable) return null;
  const items = (await itemsForOrders([orderId], db)).get(orderId) ?? [];
  // A line lost by a join would refill fewer items than the order had and call it complete.
  if (!linesAddUp(order.orderNo, items, order.subtotal, "reorder")) return null;
  return items.map(({ sku, name, variant, qty }) => ({ sku, name, variant, qty }));
}
