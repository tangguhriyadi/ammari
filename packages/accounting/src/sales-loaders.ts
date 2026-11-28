import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { auditLog, paymentNotifications, orderChannelFees, orderItems, orderManualPayments, orders, payments, shipments, stockMovements } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "./ledger-write";
import type { OrderSnapshot } from "./rules/sales";

// Snapshot loader for the Session 9 sales rule (rules/sales.ts). Read-only: the ledger is derived
// from orders, stock movements, payments, the record_refund audit rows, shipments, marketplace fees
// and order_manual_payments, and never writes them.

/** Ids are batched so one IN list never grows past what Postgres takes comfortably. */
const CHUNK = 1000;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += CHUNK) out.push(values.slice(index, index + CHUNK));
  return out;
}

/** Every order with something to book: stock that left, a payment that arrived, or a charged
 * courier booking. An unpaid order that never reached to_ship has none of these. */
export async function loadOrderSnapshots(db: Database): Promise<OrderSnapshot[]> {
  const orderId = qualifiedColumn(orders, orders.id);
  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      subtotalAmount: orders.subtotalAmount,
      shippingAmount: orders.shippingAmount,
      discountAmount: orders.discountAmount,
      totalAmount: orders.totalAmount,
      shippingSubsidyAmount: orders.shippingSubsidyAmount,
      shippedAt: orders.shippedAt,
      cancelledAt: orders.cancelledAt,
      returnedAt: orders.returnedAt,
      // T8 (tiktok-shop-integration.md §5.1): the real ship and return times. Shopee's stay NULL
      // until its own Session 5; the rule code and SALES_RULE_VERSION are unchanged.
      marketplaceShippedAt: orders.marketplaceShippedAt,
      marketplaceReturnedAt: orders.marketplaceReturnedAt,
    })
    .from(orders)
    // One id list from three index-served sources (a UNION, so the planner can semi-join instead of
    // probing three correlated subqueries per order).
    .where(
      sql`${orderId} in (
        select oi.order_id from order_items oi join stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id::text
        union select p.order_id from payments p where p.paid_at is not null
        union select s.order_id from shipments s where s.booked_at is not null and s.cost_amount is not null
      )`,
    )
    .orderBy(asc(orders.createdAt), asc(orders.id));
  if (rows.length === 0) return [];

  const byId = new Map<string, OrderSnapshot>(
    rows.map((row) => [row.id, { ...row, manualPayment: null, movements: [], payments: [], shipments: [], fees: [] }]),
  );

  for (const ids of chunks([...byId.keys()])) {
    const movementRows = await db
      .select({ orderId: orderItems.orderId, id: stockMovements.id, type: stockMovements.type, sku: stockMovements.sku, valueAmount: stockMovements.valueAmount, createdAt: stockMovements.createdAt })
      .from(stockMovements)
      .innerJoin(orderItems, and(eq(stockMovements.refType, "order_item"), sql`${stockMovements.refId} = ${orderItems.id}::text`))
      .where(and(inArray(orderItems.orderId, ids), inArray(stockMovements.type, ["sale", "return"])))
      .orderBy(asc(stockMovements.createdAt), asc(stockMovements.id));
    for (const { orderId: id, type, ...movement } of movementRows) {
      if (type === "sale" || type === "return") byId.get(id)?.movements.push({ ...movement, type });
    }

    const refundRows = (await db
      .select({
        paymentId: sql<string | null>`${auditLog.after} -> 'payment' ->> 'id'`,
        amount: sql<string | null>`${auditLog.after} ->> 'amount'`,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(and(eq(auditLog.action, "record_refund"), eq(auditLog.entityType, "order"), inArray(auditLog.entityId, ids)))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))) as { paymentId: string | null; amount: string | null; createdAt: Date }[];
    // recordManualRefund refunds an attempt in full once, so one row per attempt; the first wins.
    const manualRefunds = new Map<string, { amount: number; recordedAt: Date }>();
    for (const row of refundRows) {
      const amount = Number(row.amount);
      if (!row.paymentId || !Number.isSafeInteger(amount) || amount <= 0 || manualRefunds.has(row.paymentId)) continue;
      manualRefunds.set(row.paymentId, { amount, recordedAt: row.createdAt });
    }

    const paymentRows = await db
      .select({
        orderId: payments.orderId,
        id: payments.id,
        providerOrderId: payments.providerOrderId,
        status: payments.status,
        grossAmount: payments.grossAmount,
        paidAt: payments.paidAt,
        refundedAmount: payments.refundedAmount,
        updatedAt: payments.updatedAt,
      })
      .from(payments)
      .where(inArray(payments.orderId, ids))
      .orderBy(asc(payments.attempt));
    // When the gateway first reported a refund or chargeback for each attempt: a stable date, unlike
    // payments.updated_at (every later status read bumps it). Only signature-valid notifications.
    const seenRows = paymentRows.length === 0 ? [] : ((await db
      .select({
        providerOrderId: paymentNotifications.providerOrderId,
        refundAt: sql<Date | null>`min(${paymentNotifications.receivedAt}) filter (where ${paymentNotifications.transactionStatus} in ('refund', 'partial_refund'))`,
        chargebackAt: sql<Date | null>`min(${paymentNotifications.receivedAt}) filter (where ${paymentNotifications.transactionStatus} in ('chargeback', 'partial_chargeback'))`,
      })
      .from(paymentNotifications)
      .where(and(inArray(paymentNotifications.providerOrderId, paymentRows.map((row) => row.providerOrderId)), eq(paymentNotifications.signatureValid, true)))
      .groupBy(paymentNotifications.providerOrderId)) as { providerOrderId: string | null; refundAt: Date | string | null; chargebackAt: Date | string | null }[]);
    const asDate = (value: Date | string | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value));
    const seen = new Map(seenRows.map((row) => [row.providerOrderId, { refundAt: asDate(row.refundAt), chargebackAt: asDate(row.chargebackAt) }]));
    for (const { orderId: id, ...payment } of paymentRows) {
      const notified = seen.get(payment.providerOrderId);
      byId.get(id)?.payments.push({ ...payment, gatewayRefundSeenAt: notified?.refundAt ?? null, chargebackSeenAt: notified?.chargebackAt ?? null, manualRefund: manualRefunds.get(payment.id) ?? null });
    }

    const shipmentRows = await db
      .select({ orderId: shipments.orderId, id: shipments.id, attempt: shipments.attempt, status: shipments.status, costAmount: shipments.costAmount, bookedAt: shipments.bookedAt, cancelledAt: shipments.cancelledAt })
      .from(shipments)
      .where(and(inArray(shipments.orderId, ids), isNotNull(shipments.bookedAt)))
      .orderBy(asc(shipments.attempt));
    for (const { orderId: id, ...shipment } of shipmentRows) byId.get(id)?.shipments.push(shipment);

    const feeRows = await db
      .select({ orderId: orderChannelFees.orderId, component: orderChannelFees.component, amount: orderChannelFees.amount })
      .from(orderChannelFees)
      .where(inArray(orderChannelFees.orderId, ids))
      .orderBy(asc(orderChannelFees.component));
    for (const { orderId: id, ...fee } of feeRows) byId.get(id)?.fees.push(fee);

    const manualRows = await db
      .select({ orderId: orderManualPayments.orderId, method: orderManualPayments.method, cashAccountCode: orderManualPayments.cashAccountCode, paidOn: orderManualPayments.paidOn })
      .from(orderManualPayments)
      .where(inArray(orderManualPayments.orderId, ids));
    for (const { orderId: id, ...payment } of manualRows) {
      const order = byId.get(id);
      if (order) order.manualPayment = payment;
    }
  }
  return [...byId.values()];
}
