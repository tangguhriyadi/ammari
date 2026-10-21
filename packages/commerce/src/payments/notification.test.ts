import { randomInt } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard, shippingQuoteValues } from "@ammari/db/test-fixtures";
import {
  auditLog,
  customers,
  fabricColors,
  fabrics,
  orderItems,
  orders,
  paymentNotifications,
  payments,
  products,
  productVariants,
  stockMovements,
  stockReservations,
  thankYouCards,
  vouchers,
} from "@ammari/db/schema";
import type { Tx } from "../db";
import { adjustStock } from "../stock/ledger";
import { transitionOrderStatus } from "../orders/lifecycle";
import { reserveStockForOrder } from "../stock/reservations";
import { reopenPaymentPage } from "./attempts";
import { createFakePaymentProvider } from "./fake";
import { handlePaymentNotification } from "./notification";
import type { PaymentProvider, PaymentStatusReport } from "./provider";
import { midtransSignature, parsePaymentStatusBody, verifyMidtransSignature } from "./status";
import { cancelCheckoutOrderByStaff } from "./staff";
import { syncLatestPaymentStatus } from "./sync";
import { fakeMidtransServerKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §6.1, §6.2, §6.4, D3, D4, D6, session 11: the notification handler
// and the payment state machine against the test database, with a stub gateway (the status it
// answers is set per test; nothing reaches Midtrans).

const KEY = fakeMidtransServerKey("sandbox", "NOTIFICATION");
const PRICE = 259_000;
const UNIT_COST = 100_000;

// ---------- stub gateway ----------

/** The status bodies the stub gateway answers, by provider order id. */
const gateway = new Map<string, Record<string, unknown> | "down">();
const statusCalls: string[] = [];
/** One-off answers, consumed in order before `gateway` (to interleave two concurrent calls). */
const gatewayQueue = new Map<string, Record<string, unknown>[]>();

const provider: PaymentProvider = {
  ...createFakePaymentProvider({ baseUrl: "http://localhost:3000" }),
  name: "midtrans",
  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusReport | null> {
    statusCalls.push(providerOrderId);
    const queued = gatewayQueue.get(providerOrderId)?.shift();
    const body = queued ?? gateway.get(providerOrderId);
    if (body === "down") {
      const { PaymentProviderError } = await import("./provider");
      throw new PaymentProviderError("unavailable", "stub gateway down");
    }
    return body ? parsePaymentStatusBody(body) : null;
  },
  verifyNotificationSignature: (fields) => verifyMidtransSignature(fields, KEY),
};

function statusBody(providerOrderId: string, transactionStatus: string, grossAmount: number, overrides: Record<string, unknown> = {}) {
  return {
    order_id: providerOrderId,
    transaction_status: transactionStatus,
    status_code: transactionStatus === "settlement" ? "200" : transactionStatus === "pending" ? "201" : "407",
    gross_amount: `${grossAmount}.00`,
    currency: "IDR",
    payment_type: "qris",
    transaction_id: `trx-${providerOrderId}`,
    fraud_status: "accept",
    ...overrides,
  };
}

/** Sets what the gateway answers and returns the signed notification Midtrans would send. */
function gatewaySays(providerOrderId: string, transactionStatus: string, grossAmount: number, overrides: Record<string, unknown> = {}): string {
  const body = statusBody(providerOrderId, transactionStatus, grossAmount, overrides);
  gateway.set(providerOrderId, body);
  return notification(body);
}

/** A notification body as Midtrans signs it (what it says is never trusted beyond the signature). */
function notification(body: Record<string, unknown>, key = KEY): string {
  const signatureKey = midtransSignature({ orderId: String(body.order_id), statusCode: String(body.status_code), grossAmount: String(body.gross_amount) }, key);
  return JSON.stringify({ ...body, signature_key: signatureKey });
}

// ---------- fixtures ----------

function orderNumber(): string {
  return `ORD-2099${String(randomInt(10, 99))}-${String(randomInt(10_000_000, 99_999_999))}`;
}

interface CheckoutFixture {
  orderId: string;
  orderNo: string;
  sku: string;
  slug: string;
  itemId: string;
  providerOrderId: string;
  paymentId: string;
  total: number;
  voucherId: string | null;
}

/** A placed checkout order as placeOrder leaves it: one line of `qty`, its stock held, attempt 1
 * with a page, optionally a redeemed voucher. Stock on hand: `stock` pieces at Rp100.000 each. */
async function checkoutOrder(
  db: TestDatabase,
  options: { stock?: number; qty?: number; voucher?: { expired?: boolean }; holdExpired?: boolean; withPage?: boolean } = {},
): Promise<CheckoutFixture> {
  const { product, variant } = await insertProductVariant(db);
  const stock = options.stock ?? 5;
  const qty = options.qty ?? 1;
  if (stock > 0) await db.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * UNIT_COST, type: "production", refType: "manual" });

  const customer = await insertCustomer(db);
  const subtotal = qty * PRICE;
  const discount = options.voucher ? 20_000 : 0;
  const quote = shippingQuoteValues(95_000);
  const total = subtotal + (quote.shippingAmount ?? 0) - discount;
  const orderNo = orderNumber();
  const order = await insertOrder(db, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo,
    customerId: customer.id,
    subtotalAmount: subtotal,
    discountAmount: discount,
    totalAmount: total,
    contactEmail: customer.email,
    contactPhone: "+6281234567890",
    recipientName: "Siti Aminah",
  });
  const [item] = await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty, unitPrice: PRICE, unitCost: 0 }).returning();
  if (!item) throw new Error("item fixture");
  await reserveStockForOrder(db as Tx, order.id, [{ orderItemId: item.id, sku: variant.sku, qty }], 75);
  if (options.holdExpired) {
    await db.update(stockReservations).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(stockReservations.orderId, order.id));
  }

  let voucherId: string | null = null;
  if (options.voucher) {
    const sourceOrder = await insertOrder(db);
    const card = await insertThankYouCard(db, sourceOrder.id, { status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date() });
    const [voucher] = await db
      .insert(vouchers)
      .values({
        cardId: card.id,
        customerId: customer.id,
        amount: 20_000,
        status: "used",
        usedOrderId: order.id,
        usedAt: new Date(),
        ...(options.voucher.expired ? { issuedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } : {}),
        expiresAt: options.voucher.expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning();
    voucherId = voucher?.id ?? null;
  }

  const providerOrderId = `TEST-${orderNo}-1`;
  const [payment] = await db
    .insert(payments)
    .values({
      orderId: order.id,
      provider: "midtrans",
      providerOrderId,
      attempt: 1,
      grossAmount: total,
      status: "created",
      // Without a page: an attempt whose page request ended a minute ago (not still in flight).
      ...(options.withPage === false
        ? { createdAt: new Date(Date.now() - 60_000) }
        : { snapToken: "snap-token", redirectUrl: "https://app.sandbox.midtrans.com/snap/v4/redirection/snap-token" }),
      expiresAt: order.paymentExpiresAt,
    })
    .returning();
  if (!payment) throw new Error("payment fixture");
  return { orderId: order.id, orderNo, sku: variant.sku, slug: product.slug, itemId: item.id, providerOrderId, paymentId: payment.id, total, voucherId };
}

async function orderRow(db: TestDatabase, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order vanished");
  return row;
}

async function paymentRow(db: TestDatabase, id: string) {
  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  if (!row) throw new Error("payment vanished");
  return row;
}

async function sales(db: TestDatabase, sku: string) {
  return db.select().from(stockMovements).where(and(eq(stockMovements.sku, sku), eq(stockMovements.type, "sale")));
}

async function holds(db: TestDatabase, orderId: string) {
  return db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
}

async function logRows(db: TestDatabase, providerOrderId: string) {
  return db.select().from(paymentNotifications).where(eq(paymentNotifications.providerOrderId, providerOrderId));
}

// ---------- the notification handler, in rolled-back transactions ----------

describe("handlePaymentNotification", () => {
  test("settlement: paid through transitionOrderStatus (sale movements, unit_cost at the moving average, holds consumed), logged without the signature", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { stock: 4, qty: 2 });
      const handled = await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));

      expect(handled).toEqual({ httpStatus: 200, result: "paid", orderNo: fixture.orderNo, productSlugs: [fixture.slug] });
      const order = await orderRow(tx, fixture.orderId);
      expect(order).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: [] });
      expect(order.paidAt).toBeInstanceOf(Date);
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, fixture.itemId));
      expect(item?.unitCost).toBe(UNIT_COST);
      expect(await sales(tx, fixture.sku)).toMatchObject([{ qty: -2, valueAmount: -2 * UNIT_COST, refId: fixture.itemId, createdByStaffUserId: null }]);
      expect((await holds(tx, fixture.orderId)).map((hold) => hold.status)).toEqual(["consumed"]);

      const payment = await paymentRow(tx, fixture.paymentId);
      expect(payment).toMatchObject({ status: "paid", paymentType: "qris", providerRef: `trx-${fixture.providerOrderId}` });
      expect(payment.paidAt).toBeInstanceOf(Date);
      expect(payment.lastStatus).toMatchObject({ transaction_status: "settlement", gross_amount: `${fixture.total}.00` });

      const [log] = await logRows(tx, fixture.providerOrderId);
      expect(log).toMatchObject({ signatureValid: true, transactionStatus: "settlement", statusCode: "200", result: "paid" });
      expect(log?.processedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(log?.payload)).not.toContain("signature_key");

      // The transition is audit-logged without a staff actor.
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, fixture.orderId), eq(auditLog.action, "transition_status")));
      expect(audits).toMatchObject([{ actorStaffUserId: null }]);
    });
  });

  test("a duplicate notification is a no-op: one sale, still paid, every delivery logged", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const body = gatewaySays(fixture.providerOrderId, "settlement", fixture.total);
      await handlePaymentNotification(tx, provider, body);
      const again = await handlePaymentNotification(tx, provider, body);
      expect(again).toMatchObject({ httpStatus: 200, result: "unchanged", productSlugs: [] });
      expect(await sales(tx, fixture.sku)).toHaveLength(1);
      expect((await orderRow(tx, fixture.orderId)).status).toBe("to_ship");
      expect((await logRows(tx, fixture.providerOrderId)).map((row) => row.result).sort()).toEqual(["paid", "unchanged"]);
    });
  });

  test("out of order: what the notification says is ignored, the fetched status decides", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      // A late "pending" notification arrives after the buyer paid: the gateway already says settlement.
      gateway.set(fixture.providerOrderId, statusBody(fixture.providerOrderId, "settlement", fixture.total));
      const latePending = notification(statusBody(fixture.providerOrderId, "pending", fixture.total));
      expect((await handlePaymentNotification(tx, provider, latePending)).result).toBe("paid");

      // An "expire" notification for the paid attempt (forged order of events) changes nothing.
      const lateExpire = notification(statusBody(fixture.providerOrderId, "expire", fixture.total));
      expect((await handlePaymentNotification(tx, provider, lateExpire)).result).toBe("unchanged");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: [] });

      // And a pending notification first, then settlement: pending first, then paid.
      const second = await checkoutOrder(tx);
      expect((await handlePaymentNotification(tx, provider, gatewaySays(second.providerOrderId, "pending", second.total))).result).toBe("pending");
      expect((await paymentRow(tx, second.paymentId)).status).toBe("pending");
      expect((await handlePaymentNotification(tx, provider, gatewaySays(second.providerOrderId, "settlement", second.total))).result).toBe("paid");
    });
  });

  test("a bad signature: 403, logged as invalid with only the identifying fields, nothing fetched or changed", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      gateway.set(fixture.providerOrderId, statusBody(fixture.providerOrderId, "settlement", fixture.total));
      const before = statusCalls.length;
      const forged = notification({ ...statusBody(fixture.providerOrderId, "settlement", fixture.total), extra: "x".repeat(1000) }, fakeMidtransServerKey("sandbox", "WRONG"));

      expect(await handlePaymentNotification(tx, provider, forged)).toMatchObject({ httpStatus: 403, result: "bad_signature" });
      expect(statusCalls.length).toBe(before);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      const [log] = await logRows(tx, fixture.providerOrderId);
      expect(log).toMatchObject({ signatureValid: false, result: "bad_signature" });
      expect(Object.keys(log?.payload as object).sort()).toEqual(["gross_amount", "order_id", "status_code", "transaction_status"]);

      // A body without the signed fields, or not JSON at all: 400, still logged.
      expect((await handlePaymentNotification(tx, provider, "{nope")).httpStatus).toBe(400);
      expect((await handlePaymentNotification(tx, provider, JSON.stringify({ order_id: fixture.providerOrderId }))).httpStatus).toBe(400);
      expect(await logRows(tx, fixture.providerOrderId)).toHaveLength(2);
    });
  });

  test("unknown attempt: 200 and logged; provider not configured or status unavailable: 503 (Midtrans retries), logged, nothing changed", async () => {
    await withRollback(async (tx) => {
      const unknown = await handlePaymentNotification(tx, provider, notification(statusBody("OTHER-ORD-209901-0001-1", "settlement", 1000)));
      expect(unknown).toMatchObject({ httpStatus: 200, result: "unknown_order" });

      const fixture = await checkoutOrder(tx);
      const body = notification(statusBody(fixture.providerOrderId, "settlement", fixture.total));
      expect(await handlePaymentNotification(tx, null, body)).toMatchObject({ httpStatus: 503, result: "not_configured" });
      gateway.set(fixture.providerOrderId, "down");
      expect(await handlePaymentNotification(tx, provider, body)).toMatchObject({ httpStatus: 503, result: "status_unavailable" });
      gateway.delete(fixture.providerOrderId);
      expect(await handlePaymentNotification(tx, provider, body)).toMatchObject({ httpStatus: 503, result: "status_not_found" });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect((await logRows(tx, fixture.providerOrderId)).map((row) => row.result).sort()).toEqual(["not_configured", "status_not_found", "status_unavailable"]);
    });
  });

  test("paid after the hold expired (order still awaiting payment): still sold, unit_cost locked, expired holds consumed", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { stock: 2, holdExpired: true });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("paid");
      expect((await orderRow(tx, fixture.orderId)).status).toBe("to_ship");
      expect((await holds(tx, fixture.orderId))[0]?.status).toBe("consumed");
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, fixture.itemId));
      expect(item?.unitCost).toBe(UNIT_COST);
    });
  });

  test("paid after the hold was released (order still awaiting payment): still sold; consuming is a no-op", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { stock: 2 });
      await tx.update(stockReservations).set({ status: "released", releasedAt: sql`now()` }).where(eq(stockReservations.orderId, fixture.orderId));
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("paid");
      expect(await sales(tx, fixture.sku)).toHaveLength(1);
      expect((await holds(tx, fixture.orderId))[0]?.status).toBe("released");
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, fixture.itemId));
      expect(item?.unitCost).toBe(UNIT_COST);
    });
  });

  test("paid after the order expired: recorded as paid, nothing sold, flagged paid_after_cancel + refund_due; the restored voucher stays restored", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { voucher: {} });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "expire", fixture.total))).result).toBe("expired");
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("paid_after_cancel");

      const order = await orderRow(tx, fixture.orderId);
      expect(order).toMatchObject({ status: "cancelled", paymentStatus: "paid", cancelReason: "payment_expired", needsAttention: ["paid_after_cancel", "refund_due"] });
      expect(order.paidAt).toBeInstanceOf(Date);
      expect(await sales(tx, fixture.sku)).toHaveLength(0);
      expect((await paymentRow(tx, fixture.paymentId)).status).toBe("paid");
      const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, fixture.voucherId!));
      expect(voucher).toMatchObject({ status: "active", usedOrderId: null });
    });
  });

  test("stock short at payment (an admin adjustment took the held piece): payment kept, order stays awaiting_payment, flagged, nothing sold", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { stock: 1 });
      const staff = await insertStaffUser(tx);
      // D4: admin stock writes check physical stock only, so the held piece can leave.
      await adjustStock({ sku: fixture.sku, deltaQty: -1, reason: "damaged" }, staff.id, tx);

      const handled = await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));
      expect(handled).toMatchObject({ httpStatus: 200, result: "paid_stock_short", productSlugs: [] });
      const order = await orderRow(tx, fixture.orderId);
      expect(order).toMatchObject({ status: "awaiting_payment", paymentStatus: "paid", needsAttention: ["stock_short_at_payment"] });
      expect(order.paidAt).toBeInstanceOf(Date);
      expect(await sales(tx, fixture.sku)).toHaveLength(0);
      expect((await paymentRow(tx, fixture.paymentId)).status).toBe("paid");
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, fixture.itemId));
      expect(item?.unitCost).toBe(0);

      // A replay neither sells nor flags twice; staff "Proses" works once stock is back.
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("unchanged");
      await tx.insert(stockMovements).values({ sku: fixture.sku, qty: 1, valueAmount: UNIT_COST, type: "production", refType: "manual" });
      await transitionOrderStatus(fixture.orderId, "to_ship", staff.id, tx);
      // "Proses" resolves the flag in the same update (session 16).
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: [] });
    });
  });

  test("amount or currency mismatch, a card payment type, a card-only status, a fraud status other than accept, an unknown status: flagged, never paid", async () => {
    await withRollback(async (tx) => {
      const cases: [Record<string, unknown> | ((total: number) => Record<string, unknown>), string, string][] = [
        [(total) => ({ gross_amount: `${total + 1}.00` }), "amount_mismatch", "amount_mismatch"],
        [{ currency: "USD" }, "amount_mismatch", "amount_mismatch"],
        [{ payment_type: "credit_card" }, "anomaly", "payment_anomaly"],
        [{ transaction_status: "capture" }, "anomaly", "payment_anomaly"],
        [{ fraud_status: "challenge" }, "anomaly", "payment_anomaly"],
        [{ transaction_status: "settled_maybe" }, "unknown_status", "payment_anomaly"],
      ];
      for (const [override, outcome, flag] of cases) {
        const fixture = await checkoutOrder(tx);
        const extra = typeof override === "function" ? override(fixture.total) : override;
        const status = typeof extra.transaction_status === "string" ? extra.transaction_status : "settlement";
        const handled = await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, status, fixture.total, extra));
        expect(handled.result).toBe(outcome);
        const order = await orderRow(tx, fixture.orderId);
        expect(order).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", needsAttention: [flag] });
        expect((await paymentRow(tx, fixture.paymentId)).status).toBe("created");
        expect(await sales(tx, fixture.sku)).toHaveLength(0);
      }
    });
  });

  test("deny then settlement: failed first (the order waits), then paid", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "deny", fixture.total))).result).toBe("failed");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("paid");
    });
  });

  test("refund after payment: refund_received, payment and order refunded", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "refund", fixture.total, { status_code: "200" }))).result).toBe("refunded");
      expect(await paymentRow(tx, fixture.paymentId)).toMatchObject({ status: "refunded", refundedAmount: fixture.total });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ paymentStatus: "refunded", needsAttention: ["refund_received"] });
    });
  });
});

describe("cancel paths restore the voucher (plan §6.4)", () => {
  test("expire: cancelled with payment_expired, holds released, voucher active again", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { voucher: {} });
      const handled = await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "expire", fixture.total));
      expect(handled).toMatchObject({ result: "expired", productSlugs: [fixture.slug] });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      expect((await paymentRow(tx, fixture.paymentId)).status).toBe("expired");
      expect((await holds(tx, fixture.orderId))[0]?.status).toBe("released");
      const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, fixture.voucherId!));
      expect(voucher).toMatchObject({ status: "active", usedOrderId: null, usedAt: null });
    });
  });

  test("gateway cancel: cancelled with payment_cancelled, voucher restored; an expired voucher becomes expired, not active", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { voucher: { expired: true } });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "cancel", fixture.total, { status_code: "200" }))).result).toBe("cancelled");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled", cancelReason: "payment_cancelled" });
      const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, fixture.voucherId!));
      expect(voucher).toMatchObject({ status: "expired", usedOrderId: null, usedAt: null });
    });
  });

  test("admin cancel of an unpaid and of a paid checkout order restores the voucher; a return never does", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const unpaid = await checkoutOrder(tx, { voucher: {} });
      expect(await cancelCheckoutOrderByStaff(tx, provider, unpaid.orderId, staff.id)).toMatchObject({ outcome: "cancelled", refundDue: false });
      expect((await tx.select().from(vouchers).where(eq(vouchers.id, unpaid.voucherId!)))[0]?.status).toBe("active");

      const paid = await checkoutOrder(tx, { voucher: {} });
      await handlePaymentNotification(tx, provider, gatewaySays(paid.providerOrderId, "settlement", paid.total));
      expect(await cancelCheckoutOrderByStaff(tx, provider, paid.orderId, staff.id)).toMatchObject({ outcome: "cancelled", refundDue: true });
      expect((await tx.select().from(vouchers).where(eq(vouchers.id, paid.voucherId!)))[0]?.status).toBe("active");

      const returned = await checkoutOrder(tx, { voucher: {} });
      await handlePaymentNotification(tx, provider, gatewaySays(returned.providerOrderId, "settlement", returned.total));
      await transitionOrderStatus(returned.orderId, "shipped", staff.id, tx);
      await transitionOrderStatus(returned.orderId, "returned", staff.id, tx);
      expect((await tx.select().from(vouchers).where(eq(vouchers.id, returned.voucherId!)))[0]).toMatchObject({ status: "used", usedOrderId: returned.orderId });
    });
  });

  test("an older attempt expiring never cancels an order whose newer attempt is open", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { withPage: false });
      const runtime = { provider, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 };
      const reopened = await reopenPaymentPage(tx, runtime, { orderId: fixture.orderId, finishUrl: (orderNo) => `http://localhost:3000/checkout/finish?order=${orderNo}` });
      expect(reopened.ok).toBe(true);
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "expire", fixture.total))).result).toBe("expired");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });

      // The newer attempt pays: sold. A payment on the old one too would be a second payment.
      const second = `TEST-${fixture.orderNo}-2`;
      expect((await handlePaymentNotification(tx, provider, gatewaySays(second, "settlement", fixture.total))).result).toBe("paid");
      expect((await orderRow(tx, fixture.orderId)).status).toBe("to_ship");
    });
  });
});

describe("reopenPaymentPage (finish page retry)", () => {
  test("a new attempt for the rest of the window when attempt 1 has no page; the same page on a second tap; refused once closed or at the cap", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { withPage: false });
      const createPayment = vi.fn(provider.createPayment);
      const runtime = { provider: { ...provider, createPayment }, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 };
      const finishUrl = (orderNo: string) => `http://localhost:3000/checkout/finish?order=${orderNo}`;
      await tx.update(orders).set({ paymentExpiresAt: sql`now() + interval '30 minutes 20 seconds'` }).where(eq(orders.id, fixture.orderId));

      const first = await reopenPaymentPage(tx, runtime, { orderId: fixture.orderId, finishUrl });
      expect(first).toEqual({ ok: true, redirectUrl: `http://localhost:3000/api/test/payments/TEST-${fixture.orderNo}-2` });
      const input = createPayment.mock.calls[0]?.[0];
      expect(input).toMatchObject({ providerOrderId: `TEST-${fixture.orderNo}-2`, grossAmount: fixture.total, expiryMinutes: 30, finishUrl: finishUrl(fixture.orderNo) });
      expect(input?.lines.reduce((sum, line) => sum + line.price * line.quantity, 0)).toBe(fixture.total);
      expect(input?.lines.map((line) => line.id)).toEqual([fixture.sku, "SHIPPING"]);

      expect(await reopenPaymentPage(tx, runtime, { orderId: fixture.orderId, finishUrl })).toEqual(first);
      expect(createPayment).toHaveBeenCalledTimes(1);

      await tx.update(orders).set({ paymentExpiresAt: sql`now() + interval '1 minute'` }).where(eq(orders.id, fixture.orderId));
      expect(await reopenPaymentPage(tx, runtime, { orderId: fixture.orderId, finishUrl })).toEqual({ ok: false, reason: "closed" });
    });
  });

  test("busy while the previous attempt's page request may still be answered (no second payable page)", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { withPage: false });
      await tx.update(payments).set({ createdAt: sql`now()` }).where(eq(payments.id, fixture.paymentId));
      const runtime = { provider, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 };
      expect(await reopenPaymentPage(tx, runtime, { orderId: fixture.orderId, finishUrl: () => "http://localhost:3000/x" })).toEqual({ ok: false, reason: "busy" });
      expect(await tx.select().from(payments).where(eq(payments.orderId, fixture.orderId))).toHaveLength(1);
    });
  });

  test("a gateway failure answers unavailable and leaves the new attempt without a page", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { withPage: false });
      const failing = { ...provider, ...{ createPayment: createFakePaymentProvider({ baseUrl: "http://localhost:3000", failWith: "unavailable" }).createPayment } };
      const result = await reopenPaymentPage(tx, { provider: failing, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 }, { orderId: fixture.orderId, finishUrl: () => "http://localhost:3000/x" });
      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(await tx.select({ attempt: payments.attempt, redirectUrl: payments.redirectUrl }).from(payments).where(eq(payments.orderId, fixture.orderId))).toHaveLength(2);
    });
  });
});

describe("syncLatestPaymentStatus (finish page)", () => {
  test("applies the fetched status of the latest attempt; no transaction yet or no page is a no-op", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      gateway.delete(fixture.providerOrderId);
      expect(await syncLatestPaymentStatus(tx, provider, fixture.orderId)).toEqual({ checked: false, reason: "not_found" });

      gateway.set(fixture.providerOrderId, statusBody(fixture.providerOrderId, "settlement", fixture.total));
      const synced = await syncLatestPaymentStatus(tx, provider, fixture.orderId);
      expect(synced).toMatchObject({ checked: true, applied: { outcome: "paid", productSlugs: [fixture.slug] } });
      expect((await orderRow(tx, fixture.orderId)).status).toBe("to_ship");
      expect(await syncLatestPaymentStatus(tx, provider, fixture.orderId)).toEqual({ checked: false, reason: "not_pending" });

      const pageless = await checkoutOrder(tx, { withPage: false });
      expect(await syncLatestPaymentStatus(tx, provider, pageless.orderId)).toEqual({ checked: false, reason: "no_page" });
    });
  });
});

describe("refunds, chargebacks and duplicate payments", () => {
  test("partial refund then full refund: monotonic (a late partial never lowers the amount or the status)", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "partial_refund", fixture.total, { status_code: "200", refund_amount: "50000.00" }))).result).toBe("refunded");
      expect(await paymentRow(tx, fixture.paymentId)).toMatchObject({ status: "partially_refunded", refundedAmount: 50_000 });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ paymentStatus: "partially_refunded", needsAttention: ["refund_received"] });

      await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "refund", fixture.total, { status_code: "200" }));
      expect(await paymentRow(tx, fixture.paymentId)).toMatchObject({ status: "refunded", refundedAmount: fixture.total });
      const late = await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "partial_refund", fixture.total, { status_code: "200", refund_amount: "10000.00" }));
      expect(late.result).toBe("unchanged");
      expect(await paymentRow(tx, fixture.paymentId)).toMatchObject({ status: "refunded", refundedAmount: fixture.total });
      expect((await orderRow(tx, fixture.orderId)).paymentStatus).toBe("refunded");
    });
  });

  test("a partial refund without an amount is flagged, nothing changed", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "partial_refund", fixture.total, { status_code: "200" }))).result).toBe("anomaly");
      expect((await paymentRow(tx, fixture.paymentId)).status).toBe("paid");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ paymentStatus: "paid", needsAttention: ["payment_anomaly"] });
    });
  });

  test("a second paid attempt is refund_due; refunding it keeps the order paid", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const second = `TEST-${fixture.orderNo}-2`;
      await tx.insert(payments).values({ orderId: fixture.orderId, provider: "midtrans", providerOrderId: second, attempt: 2, grossAmount: fixture.total, status: "created", snapToken: "t2" });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total))).result).toBe("paid");
      expect((await handlePaymentNotification(tx, provider, gatewaySays(second, "settlement", fixture.total, { transaction_id: "trx-second" }))).result).toBe("paid_twice");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: ["refund_due"] });
      expect(await sales(tx, fixture.sku)).toHaveLength(1);

      expect((await handlePaymentNotification(tx, provider, gatewaySays(second, "refund", fixture.total, { status_code: "200", transaction_id: "trx-second" }))).result).toBe("refunded");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: ["refund_due", "refund_received"] });
    });
  });

  test("a refund of an attempt never recorded as paid leaves the order unsold and flags it", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "refund", fixture.total, { status_code: "200" }))).result).toBe("refunded");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", needsAttention: ["payment_anomaly", "refund_received"] });
      expect(await sales(tx, fixture.sku)).toHaveLength(0);
    });
  });

  test("chargeback: recorded and flagged; an expire for an already paid attempt is ignored and flagged", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total));
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "expire", fixture.total))).result).toBe("unchanged");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: ["payment_anomaly"] });
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "chargeback", fixture.total, { status_code: "200" }))).result).toBe("chargeback");
      expect((await paymentRow(tx, fixture.paymentId)).status).toBe("chargeback");
      expect((await orderRow(tx, fixture.orderId)).paymentStatus).toBe("chargeback");
    });
  });

  test("unverified rows above the route's cap are not written (verified ones always are)", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const forged = notification(statusBody(fixture.providerOrderId, "settlement", fixture.total), fakeMidtransServerKey("sandbox", "WRONG"));
      const refused = { admitUnverifiedRow: async () => false };
      expect((await handlePaymentNotification(tx, provider, forged, refused)).httpStatus).toBe(403);
      expect((await handlePaymentNotification(tx, provider, JSON.stringify({ order_id: fixture.providerOrderId }), refused)).httpStatus).toBe(400);
      expect(await logRows(tx, fixture.providerOrderId)).toHaveLength(0);
      expect((await handlePaymentNotification(tx, provider, gatewaySays(fixture.providerOrderId, "settlement", fixture.total), refused)).result).toBe("paid");
      expect(await logRows(tx, fixture.providerOrderId)).toHaveLength(1);
    });
  });

  test("a notification whose signed fields carry extra whitespace is refused, never normalized", async () => {
    await withRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const body = statusBody(fixture.providerOrderId, "settlement", fixture.total);
      const signature = midtransSignature({ orderId: ` ${fixture.providerOrderId}`, statusCode: "200", grossAmount: String(body.gross_amount) }, KEY);
      const spaced = JSON.stringify({ ...body, order_id: ` ${fixture.providerOrderId}`, signature_key: signature });
      expect((await handlePaymentNotification(tx, provider, spaced)).httpStatus).toBe(400);
      expect((await orderRow(tx, fixture.orderId)).paymentStatus).toBe("pending");
    });
  });
});

// ---------- two notifications at once: real, separately committed transactions ----------

describe("concurrency", () => {
  test("two notifications for the same order arriving at once sell once", async () => {
    const fixture = await checkoutOrder(testDb, { stock: 3 });
    try {
      const body = gatewaySays(fixture.providerOrderId, "settlement", fixture.total);
      const [first, second] = await Promise.all([handlePaymentNotification(testDb, provider, body), handlePaymentNotification(testDb, provider, body)]);
      expect([first.result, second.result].sort()).toEqual(["paid", "unchanged"]);
      expect(await sales(testDb, fixture.sku)).toHaveLength(1);
      expect(await orderRow(testDb, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid" });

      // A settlement and an expire racing: the fetched status (settlement) wins either way.
      const other = await checkoutOrder(testDb, { stock: 3 });
      const settle = gatewaySays(other.providerOrderId, "settlement", other.total);
      const expire = notification(statusBody(other.providerOrderId, "expire", other.total));
      await Promise.all([handlePaymentNotification(testDb, provider, settle), handlePaymentNotification(testDb, provider, expire)]);
      expect(await orderRow(testDb, other.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid" });

      // A real interleave: the first call is told "expire", the second "settlement" (the buyer paid
      // at the last second). Never a mixed state: either sold, or cancelled + paid_after_cancel.
      const raced = await checkoutOrder(testDb, { stock: 3 });
      gatewayQueue.set(raced.providerOrderId, [statusBody(raced.providerOrderId, "expire", raced.total), statusBody(raced.providerOrderId, "settlement", raced.total)]);
      gateway.set(raced.providerOrderId, statusBody(raced.providerOrderId, "settlement", raced.total));
      const any = notification(statusBody(raced.providerOrderId, "pending", raced.total));
      await Promise.all([handlePaymentNotification(testDb, provider, any), handlePaymentNotification(testDb, provider, any)]);
      const final = await orderRow(testDb, raced.orderId);
      expect(final.paymentStatus).toBe("paid");
      if (final.status === "cancelled") {
        expect(final.needsAttention).toEqual(["paid_after_cancel", "refund_due"]);
        expect(await sales(testDb, raced.sku)).toHaveLength(0);
      } else {
        expect(final.status).toBe("to_ship");
        expect(await sales(testDb, raced.sku)).toHaveLength(1);
      }

      // Two "Buka halaman pembayaran" taps at once: one new attempt, never two payable pages.
      const pageless = await checkoutOrder(testDb, { withPage: false });
      const runtime = { provider, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 };
      const reopen = () => reopenPaymentPage(testDb, runtime, { orderId: pageless.orderId, finishUrl: () => "http://localhost:3000/x" });
      const results = await Promise.all([reopen(), reopen()]);
      // The loser either waited and got the same page, or was told the page is being prepared.
      const pages = new Set(results.flatMap((result) => (result.ok ? [result.redirectUrl] : [])));
      expect(pages.size).toBe(1);
      expect(results.filter((result) => !result.ok)).toEqual(results.filter((result) => !result.ok).map(() => ({ ok: false, reason: "busy" })));
      const attempts = await testDb.select({ attempt: payments.attempt }).from(payments).where(eq(payments.orderId, pageless.orderId));
      expect(attempts).toHaveLength(2);

      await cleanUp([fixture, other, raced, pageless]);
    } catch (error) {
      await cleanUp([fixture]).catch(() => undefined);
      throw error;
    }
  });
});

async function cleanUp(fixtures: CheckoutFixture[]): Promise<void> {
  const orderIds = fixtures.map((fixture) => fixture.orderId);
  const skus = fixtures.map((fixture) => fixture.sku);
  const providerOrderIds = fixtures.map((fixture) => fixture.providerOrderId);
  const customerIds = (await testDb.select({ id: orders.customerId }).from(orders).where(inArray(orders.id, orderIds))).map((row) => row.id).filter((id): id is string => id !== null);
  await testDb.delete(paymentNotifications).where(inArray(paymentNotifications.providerOrderId, providerOrderIds));
  await testDb.delete(payments).where(inArray(payments.orderId, orderIds));
  await testDb.delete(stockReservations).where(inArray(stockReservations.orderId, orderIds));
  await testDb.delete(auditLog).where(inArray(auditLog.entityId, orderIds));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, skus)));
  await testDb.delete(thankYouCards).where(inArray(thankYouCards.orderId, orderIds));
  await testDb.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
  await testDb.delete(orders).where(inArray(orders.id, orderIds));
  if (customerIds.length > 0) await testDb.delete(customers).where(inArray(customers.id, customerIds));
  const variantRows = await testDb.select({ productId: productVariants.productId, colorId: productVariants.fabricColorId, fabricId: productVariants.fabricId }).from(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(products).where(inArray(products.id, variantRows.map((row) => row.productId)));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, variantRows.map((row) => row.colorId)));
  await testDb.delete(fabrics).where(inArray(fabrics.id, variantRows.map((row) => row.fabricId)));
}
