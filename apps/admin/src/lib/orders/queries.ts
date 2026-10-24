import "server-only";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  channels,
  customers,
  fabricColors,
  orderItems,
  orderNotifications,
  orders,
  payments,
  shipmentEvents,
  shipments,
  products,
  productVariants,
  shippingAreas,
  staffUsers,
  thankYouCards,
  vouchers,
} from "@ammari/db/schema";
import type { ChannelId, OrderAttentionFlag, OrderNotificationKind, OrderPaymentStatus, OrderStatus, PaymentStatus, ShipmentEventSource, ShipmentStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { resolveUnitPrice } from "@ammari/db/pricing";
import { productPricingColumns } from "@ammari/db/pricing-columns";
import { defaultDb, type Database } from "@/lib/db";
import { channelDisplayNameSql } from "./channel-label";
import { orderBuyerNameSql } from "./buyer-name";

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
  const rows = await db
    .select({ id: channels.id, name: channelDisplayNameSql(channels.id, channels.name) })
    .from(channels)
    .orderBy(channelDisplayNameSql(channels.id, channels.name));
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
  /** The price prefilled into the order form, editable per line before submit:
   * `resolveUnitPrice(product, now, { variantPriceOverride })` (docs/plans/product-discount.md
   * §5.2, owner answer 2). Without an active discount that is priceOverrideAmount ?? basePrice;
   * with one it is the product's sale price, but only when that is below the variant's own list
   * price (a discount never raises a price). */
  effectivePrice: number;
  /** The undiscounted price (override ?? base); equal to effectivePrice when not discounted. */
  listPrice: number;
  discounted: boolean;
}

/** Active variants across every product — the /orders/new SKU picker's source list. Flat rows,
 * grouped product -> color -> size client-side, same division of labor as production's
 * listEligibleSkusForFabric/BatchLinePicker. */
export async function listOrderableVariants(db: Database = defaultDb, now: Date = new Date()): Promise<OrderableVariantRow[]> {
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
      ...productPricingColumns,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.isActive, true))
    .orderBy(products.name, fabricColors.name, productVariants.size);

  return rows.map(({ priceOverrideAmount, basePrice, discountPriceAmount, discountEnabled, discountStartsAt, discountEndsAt, ...row }) => {
    const price = resolveUnitPrice(
      { basePrice, discountPriceAmount, discountEnabled, discountStartsAt, discountEndsAt },
      now,
      { variantPriceOverride: priceOverrideAmount },
    );
    return { ...row, effectivePrice: price.unitPrice, listPrice: price.listPrice, discounted: price.discounted };
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
  /** Set only on web checkout orders (docs/plans/cart-checkout.md §3); NULL for manual and
   * marketplace orders. */
  paymentStatus: OrderPaymentStatus | null;
  needsAttention: OrderAttentionFlag[];
}

export interface ListOrdersFilters {
  status?: OrderStatus;
  /** "Perlu dicek": orders with at least one needs_attention flag (plan §3, the partial index
   * `orders_needs_attention_idx`). */
  needsAttention?: boolean;
  q?: string;
}

/** The "Perlu dicek" condition, spelled like the partial index's predicate so it can be used. */
const NEEDS_ATTENTION = sql`cardinality(${orders.needsAttention}) > 0`;

/** How many orders carry a flag (the "Perlu dicek" tab's count). */
export async function countOrdersNeedingAttention(db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(NEEDS_ATTENTION);
  return row?.count ?? 0;
}

export async function listOrders(
  filters: ListOrdersFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: OrderListRow[]; pagination: Pagination }> {
  const conditions = [
    filters.status ? eq(orders.status, filters.status) : undefined,
    filters.needsAttention ? NEEDS_ATTENTION : undefined,
    filters.q
      ? or(ilike(orders.orderNo, `%${filters.q}%`), ilike(orders.channelOrderNo, `%${filters.q}%`), ilike(customers.name, `%${filters.q}%`), ilike(orders.recipientName, `%${filters.q}%`))
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
      channelName: channelDisplayNameSql(channels.id, channels.name),
      channelOrderNo: orders.channelOrderNo,
      status: orders.status,
      customerName: orderBuyerNameSql(),
      buyerUsername: orders.buyerUsername,
      orderDate: orders.orderDate,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
      paymentStatus: orders.paymentStatus,
      needsAttention: orders.needsAttention,
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
  /** `order_items.list_unit_price`: the normal price when the line was charged less (a product
   * discount at checkout, or a lower manual price); null otherwise. Shown struck through. */
  listUnitPrice: number | null;
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
  /** Entered by staff at "Tandai dikirim" or "Tambah resi" (any channel). */
  courier: string | null;
  trackingNumber: string | null;
  createdByName: string | null;
  createdAt: Date;
  items: OrderItemRow[];
  /** `null` = no card claimed (yet, or ever) for this order. Set once a buyer claims the
   * thank-you card's voucher on the main site (apps/web's `/claim/[token]`, docs/plans/
   * voucher-claim.md session 2). */
  cardClaimedAt: Date | null;
  /** Web checkout data (plan §7); null for manual and marketplace orders. */
  checkout: CheckoutOrderDetail | null;
}

export interface CheckoutPaymentAttempt {
  id: string;
  attempt: number;
  providerOrderId: string;
  /** Midtrans transaction id. */
  providerRef: string | null;
  status: PaymentStatus;
  paymentType: string | null;
  bank: string | null;
  grossAmount: number;
  refundedAmount: number;
  paidAt: Date | null;
  createdAt: Date;
  /** The gateway's last reported `transaction_status`, raw (shown to staff as is). */
  gatewayStatus: string | null;
}

export interface CheckoutShippingQuote {
  courierLabel: string;
  courierCode: string;
  serviceCode: string;
  weightGrams: number;
  /** The courier cost as quoted and Ammari's subsidy: shipping expense figures, so `null` for a
   * viewer without finance.view_profit (stripOrderDetailCost), like unit_cost. */
  costAmount: number | null;
  subsidyAmount: number | null;
  /** What the buyer paid for ongkir (= orders.shipping_amount, already on the order totals). */
  buyerAmount: number;
  quotedAt: Date;
  /** "Kecamatan, Kota, Provinsi 12345" from the shipping_areas row, when still there. */
  destinationLabel: string | null;
}

export interface CheckoutAddress {
  recipientName: string;
  phone: string;
  addressLine: string;
  district: string;
  city: string;
  province: string;
  postalCode: string;
  notes: string | null;
}

/** One courier booking attempt (Phase K2), newest first on the order. */
export interface CheckoutShipment {
  id: string;
  attempt: number;
  referenceId: string;
  status: ShipmentStatus;
  providerStatus: string | null;
  courier: string;
  service: string;
  awb: string | null;
  routingCode: string | null;
  /** What Ammari pays the courier: a cost figure, so `null` without finance.view_profit. */
  costAmount: number | null;
  /** Whether the price is known at all (shown as "biaya belum diketahui" otherwise, to anyone). */
  costKnown: boolean;
  driverName: string | null;
  driverPhone: string | null;
  driverPlateNumber: string | null;
  lastError: string | null;
  bookedAt: Date | null;
  pickedUpAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelledAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  /** The provider's order id (Biteship's), for the activation form and support. */
  providerOrderId: string | null;
  deliveredAt: Date | null;
  /** K3 poll bookkeeping: the newest courier event, the last read, the last stale mark. */
  lastEventAt: Date | null;
  lastPolledAt: Date | null;
  staleFlaggedAt: Date | null;
}

/** One courier history entry of any attempt (K3 `shipment_events`), newest first on the order. */
export interface CheckoutTrackingEvent {
  id: string;
  shipmentId: string;
  attempt: number;
  occurredAt: Date;
  /** As stored: the documented status, or the raw text when undocumented. */
  providerStatus: string;
  normalizedStatus: ShipmentStatus | null;
  description: string;
  location: string | null;
  source: ShipmentEventSource;
  /** When we stored it (from a webhook re-fetch, a poll, or staff's "Cek ulang"). */
  recordedAt: Date;
}

export interface CheckoutOrderDetail {
  paymentStatus: OrderPaymentStatus;
  paymentExpiresAt: Date | null;
  paidAt: Date | null;
  cancelReason: string | null;
  needsAttention: OrderAttentionFlag[];
  contactEmail: string | null;
  contactPhone: string | null;
  placedWithSession: boolean | null;
  promoOptIn: boolean | null;
  address: CheckoutAddress | null;
  quote: CheckoutShippingQuote | null;
  voucher: { amount: number; status: string } | null;
  attempts: CheckoutPaymentAttempt[];
  emails: { kind: OrderNotificationKind; sentAt: Date | null; error: string | null }[];
  /** Courier and resi from "Tandai dikirim". */
  courier: string | null;
  trackingNumber: string | null;
  /** Courier booking attempts, newest first (Phase K2). */
  shipments: CheckoutShipment[];
  /** Every attempt's courier history, newest first (Phase K4). */
  trackingEvents: CheckoutTrackingEvent[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The structured address of a checkout order (snapshot version 2, plan §3); null for anything
 * else, so the page falls back to the one-line `shipping_address`. */
function addressFromSnapshot(snapshot: unknown): CheckoutAddress | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  const recipientName = text(value.recipientName);
  const phone = text(value.phone);
  const addressLine = text(value.addressLine);
  const district = text(value.district);
  const city = text(value.city);
  const province = text(value.province);
  const postalCode = text(value.postalCode);
  if (!recipientName || !phone || !addressLine || !district || !city || !province || !postalCode) return null;
  return { recipientName, phone, addressLine, district, city, province, postalCode, notes: text(value.notes) };
}

/** Courier history entries shown on the order page; a parcel has a handful, a rebooked one a few more. */
const TRACKING_EVENTS_LIMIT = 200;

async function getCheckoutOrderDetail(
  order: typeof orders.$inferSelect & { paymentStatus: OrderPaymentStatus },
  db: Database,
): Promise<CheckoutOrderDetail> {
  const [shipmentRows, attemptRows, emailRows, voucherRows, areaRows] = await Promise.all([
    db.select().from(shipments).where(eq(shipments.orderId, order.id)).orderBy(desc(shipments.attempt)),
    db
      .select({
        id: payments.id,
        attempt: payments.attempt,
        providerOrderId: payments.providerOrderId,
        providerRef: payments.providerRef,
        status: payments.status,
        paymentType: payments.paymentType,
        grossAmount: payments.grossAmount,
        refundedAmount: payments.refundedAmount,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
        lastStatus: payments.lastStatus,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(payments.attempt),
    db
      .select({ kind: orderNotifications.kind, sentAt: orderNotifications.sentAt, error: orderNotifications.error })
      .from(orderNotifications)
      .where(eq(orderNotifications.orderId, order.id))
      .orderBy(orderNotifications.createdAt),
    db.select({ amount: vouchers.amount, status: vouchers.status }).from(vouchers).where(eq(vouchers.usedOrderId, order.id)).limit(1),
    order.shippingAreaId
      ? db.select({ label: shippingAreas.label }).from(shippingAreas).where(eq(shippingAreas.id, order.shippingAreaId)).limit(1)
      : Promise.resolve([]),
  ]);

  const quote: CheckoutShippingQuote | null =
    order.shippingCostAmount !== null &&
    order.shippingSubsidyAmount !== null &&
    order.shippingCourierLabel !== null &&
    order.shippingCourierCode !== null &&
    order.shippingServiceCode !== null &&
    order.shippingWeightGrams !== null &&
    order.shippingQuotedAt !== null
      ? {
          courierLabel: order.shippingCourierLabel,
          courierCode: order.shippingCourierCode,
          serviceCode: order.shippingServiceCode,
          weightGrams: order.shippingWeightGrams,
          costAmount: order.shippingCostAmount,
          subsidyAmount: order.shippingSubsidyAmount,
          buyerAmount: order.shippingAmount,
          quotedAt: order.shippingQuotedAt,
          destinationLabel: areaRows[0]?.label ?? null,
        }
      : null;

  const attemptById = new Map(shipmentRows.map((row) => [row.id, row.attempt]));
  const eventRows =
    shipmentRows.length === 0
      ? []
      : await db
          .select({
            id: shipmentEvents.id,
            shipmentId: shipmentEvents.shipmentId,
            occurredAt: shipmentEvents.occurredAt,
            providerStatus: shipmentEvents.providerStatus,
            normalizedStatus: shipmentEvents.normalizedStatus,
            description: shipmentEvents.description,
            location: shipmentEvents.location,
            source: shipmentEvents.source,
            recordedAt: shipmentEvents.createdAt,
          })
          .from(shipmentEvents)
          .where(inArray(shipmentEvents.shipmentId, [...attemptById.keys()]))
          .orderBy(desc(shipmentEvents.occurredAt), desc(shipmentEvents.createdAt))
          .limit(TRACKING_EVENTS_LIMIT);

  // A voucher restored by a cancel is no longer linked to the order; the discount still shows it.
  const voucherRow = voucherRows[0];
  return {
    paymentStatus: order.paymentStatus,
    paymentExpiresAt: order.paymentExpiresAt,
    paidAt: order.paidAt,
    cancelReason: order.cancelReason,
    needsAttention: order.needsAttention,
    contactEmail: order.contactEmail,
    contactPhone: order.contactPhone,
    placedWithSession: order.placedWithSession,
    promoOptIn: order.promoOptIn,
    address: addressFromSnapshot(order.shippingAddressSnapshot),
    quote,
    voucher: voucherRow ? { amount: voucherRow.amount, status: voucherRow.status } : null,
    attempts: attemptRows.map(({ lastStatus, ...attempt }) => {
      // jsonb: only an object carries the allowlisted fields (payments/status.ts snapshot).
      const snapshot: Record<string, unknown> = lastStatus && typeof lastStatus === "object" && !Array.isArray(lastStatus) ? (lastStatus as Record<string, unknown>) : {};
      return { ...attempt, bank: text(snapshot.bank), gatewayStatus: text(snapshot.transaction_status) };
    }),
    emails: emailRows,
    courier: order.courier,
    trackingNumber: order.trackingNumber,
    shipments: shipmentRows.map((row) => ({
      id: row.id,
      attempt: row.attempt,
      referenceId: row.referenceId,
      status: row.status,
      providerStatus: row.providerStatus,
      courier: row.courier,
      service: row.service,
      awb: row.awb,
      routingCode: row.routingCode,
      costAmount: row.costAmount,
      costKnown: row.costAmount !== null,
      driverName: row.driverName,
      driverPhone: row.driverPhone,
      driverPlateNumber: row.driverPlateNumber,
      lastError: row.lastError,
      bookedAt: row.bookedAt,
      pickedUpAt: row.pickedUpAt,
      cancelRequestedAt: row.cancelRequestedAt,
      cancelledAt: row.cancelledAt,
      failedAt: row.failedAt,
      createdAt: row.createdAt,
      providerOrderId: row.providerOrderId,
      deliveredAt: row.deliveredAt,
      lastEventAt: row.lastEventAt,
      lastPolledAt: row.lastPolledAt,
      staleFlaggedAt: row.staleFlaggedAt,
    })),
    trackingEvents: eventRows.map((row) => ({ ...row, attempt: attemptById.get(row.shipmentId) ?? 0 })),
  };
}

export async function getOrderDetail(id: string, db: Database = defaultDb): Promise<OrderDetail | null> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      channelName: channelDisplayNameSql(channels.id, channels.name),
      channelOrderNo: orders.channelOrderNo,
      status: orders.status,
      customerId: orders.customerId,
      customerName: orderBuyerNameSql(),
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
      courier: orders.courier,
      trackingNumber: orders.trackingNumber,
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
      listUnitPrice: orderItems.listUnitPrice,
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

  const [full] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  const checkout =
    full && full.paymentStatus !== null ? await getCheckoutOrderDetail({ ...full, paymentStatus: full.paymentStatus }, db) : null;

  return { ...order, items: itemRows, cardClaimedAt: claimedCard?.claimedAt ?? null, checkout };
}

/** Cost data (unit_cost) is gated by finance.view_profit, same discipline every other cost field
 * in this codebase follows (see lib/inventory/purchases.ts's stripPurchaseAmount) — stripped
 * server-side, never left to the client to hide. */
export function stripOrderDetailCost(detail: OrderDetail, canViewProfit: boolean): OrderDetail {
  if (canViewProfit) return detail;
  const checkout = detail.checkout
    ? {
        ...detail.checkout,
        quote: detail.checkout.quote ? { ...detail.checkout.quote, costAmount: null, subsidyAmount: null } : null,
        shipments: detail.checkout.shipments.map((shipment) => ({ ...shipment, costAmount: null })),
      }
    : detail.checkout;
  return { ...detail, items: detail.items.map((item) => ({ ...item, unitCost: null })), checkout };
}
