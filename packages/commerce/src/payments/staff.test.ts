import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
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
  staffUsers,
  stockMovements,
  stockReservations,
  thankYouCards,
  vouchers,
  type OrderAttentionFlag,
} from "@ammari/db/schema";
import type { Database, Tx } from "../db";
import { ActionError } from "../errors";
import { CHECKOUT_ORDER_CANCEL_PATH_MESSAGE, CHECKOUT_ORDER_UNPAID_MESSAGE, createOrder, transitionOrderStatus } from "../orders/lifecycle";
import { adjustStock } from "../stock/ledger";
import { reserveStockForOrder } from "../stock/reservations";
import { createFakePaymentProvider } from "./fake";
import { handlePaymentNotification } from "./notification";
import { PaymentProviderError, type PaymentProvider, type PaymentStatusReport } from "./provider";
import { FLAG_MESSAGES, REFUND_MESSAGES, STAFF_CANCEL_MESSAGES, cancelCheckoutOrderByStaff, clearAttentionFlag, recordManualRefund } from "./staff";
import { midtransSignature, parsePaymentStatusBody, verifyMidtransSignature } from "./status";
import { fakeMidtransServerKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §6.5, §7, session 16 (owner decisions 43 to 45): staff actions on
// checkout orders against the test database with a stub gateway (nothing reaches Midtrans). Manual
// and marketplace orders keep their old behavior.

const KEY = fakeMidtransServerKey("sandbox", "STAFF");
const PRICE = 259_000;
const UNIT_COST = 100_000;

// ---------- stub gateway ----------

type Answer = Record<string, unknown> | "down" | null;

interface StubGateway extends PaymentProvider {
  answers: Map<string, Answer>;
  /** "refuse": the expire call is refused (412) and the status stays what `answers` says. */
  expireAnswers: Map<string, "refuse" | "down">;
  statusCalls: string[];
  expireCalls: string[];
  delayMs: number;
}

function stubGateway(): StubGateway {
  const answers = new Map<string, Answer>();
  const expireAnswers = new Map<string, "refuse" | "down">();
  const statusCalls: string[] = [];
  const expireCalls: string[] = [];
  const gateway: StubGateway = {
    ...createFakePaymentProvider({ baseUrl: "http://localhost:3000" }),
    name: "midtrans",
    answers,
    expireAnswers,
    statusCalls,
    expireCalls,
    delayMs: 0,
    async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusReport | null> {
      statusCalls.push(providerOrderId);
      if (gateway.delayMs) await new Promise((resolve) => setTimeout(resolve, gateway.delayMs));
      const answer = answers.get(providerOrderId) ?? null;
      if (answer === "down") throw new PaymentProviderError("unavailable", "stub gateway down");
      return answer ? parsePaymentStatusBody(answer) : null;
    },
    async expirePayment(providerOrderId: string): Promise<PaymentStatusReport | null> {
      expireCalls.push(providerOrderId);
      const mode = expireAnswers.get(providerOrderId);
      if (mode === "down") throw new PaymentProviderError("unavailable", "stub gateway down");
      if (mode === "refuse") return null;
      const answer = answers.get(providerOrderId);
      if (!answer || answer === "down" || answer.transaction_status !== "pending") return null;
      const expired = { ...answer, transaction_status: "expire", status_code: "407" };
      answers.set(providerOrderId, expired);
      return parsePaymentStatusBody(expired);
    },
    verifyNotificationSignature: (fields) => verifyMidtransSignature(fields, KEY),
  };
  return gateway;
}

function statusBody(providerOrderId: string, transactionStatus: string, grossAmount: number) {
  return {
    order_id: providerOrderId,
    transaction_status: transactionStatus,
    status_code: transactionStatus === "settlement" ? "200" : transactionStatus === "pending" ? "201" : "407",
    gross_amount: `${grossAmount}.00`,
    currency: "IDR",
    payment_type: "bca_va",
    transaction_id: `trx-${providerOrderId}`,
    fraud_status: "accept",
  };
}

function signed(body: Record<string, unknown>): string {
  const signatureKey = midtransSignature({ orderId: String(body.order_id), statusCode: String(body.status_code), grossAmount: String(body.gross_amount) }, KEY);
  return JSON.stringify({ ...body, signature_key: signatureKey });
}

// ---------- fixtures ----------

interface Fixture {
  orderId: string;
  orderNo: string;
  sku: string;
  slug: string;
  total: number;
  attempts: string[];
  voucherId: string | null;
}

/** A placed, unpaid checkout order: one line, its stock held, `attempts` attempts with a page,
 * optionally a redeemed voucher. */
async function placedOrder(db: TestDatabase, options: { attempts?: number; voucher?: boolean; stock?: number } = {}): Promise<Fixture> {
  const { product, variant } = await insertProductVariant(db);
  const stock = options.stock ?? 3;
  await db.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * UNIT_COST, type: "production", refType: "manual" });
  const customer = await insertCustomer(db);
  const discount = options.voucher ? 20_000 : 0;
  const quote = shippingQuoteValues(95_000);
  const total = PRICE + (quote.shippingAmount ?? 0) - discount;
  const orderNo = `ORD-2099${String(randomInt(10, 99))}-${String(randomInt(10_000_000, 99_999_999))}`;
  const order = await insertOrder(db, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo,
    customerId: customer.id,
    subtotalAmount: PRICE,
    discountAmount: discount,
    totalAmount: total,
    contactEmail: customer.email,
    contactPhone: "+6281234567890",
    recipientName: "Siti Aminah",
  });
  const [item] = await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: PRICE, unitCost: 0 }).returning();
  if (!item) throw new Error("item fixture");
  await reserveStockForOrder(db as Tx, order.id, [{ orderItemId: item.id, sku: variant.sku, qty: 1 }], 75);

  let voucherId: string | null = null;
  if (options.voucher) {
    const card = await insertThankYouCard(db, (await insertOrder(db)).id, { status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date() });
    const [voucher] = await db
      .insert(vouchers)
      .values({ cardId: card.id, customerId: customer.id, amount: 20_000, status: "used", usedOrderId: order.id, usedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
      .returning();
    voucherId = voucher?.id ?? null;
  }

  const attempts: string[] = [];
  for (let attempt = 1; attempt <= (options.attempts ?? 1); attempt += 1) {
    const providerOrderId = `STAFF-${orderNo}-${attempt}`;
    await db.insert(payments).values({
      orderId: order.id,
      provider: "midtrans",
      providerOrderId,
      attempt,
      grossAmount: total,
      status: "pending",
      snapToken: `snap-${attempt}`,
      redirectUrl: `https://app.sandbox.midtrans.com/snap/v4/redirection/snap-${attempt}`,
      expiresAt: order.paymentExpiresAt,
    });
    attempts.push(providerOrderId);
  }
  return { orderId: order.id, orderNo, sku: variant.sku, slug: product.slug, total, attempts, voucherId };
}

/** The same order paid through the real notification path (state machine). */
async function paidOrder(db: TestDatabase, options: { attempts?: number; voucher?: boolean; stock?: number } = {}): Promise<Fixture> {
  const fixture = await placedOrder(db, options);
  const gateway = stubGateway();
  gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));
  const handled = await handlePaymentNotification(db as Database, gateway, signed(statusBody(fixture.attempts[0]!, "settlement", fixture.total)));
  expect(handled.httpStatus).toBe(200);
  return fixture;
}

async function orderRow(db: TestDatabase, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order vanished");
  return row;
}

async function attemptRows(db: TestDatabase, orderId: string) {
  return db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.attempt);
}

async function holdStatuses(db: TestDatabase, orderId: string) {
  return (await db.select({ status: stockReservations.status }).from(stockReservations).where(eq(stockReservations.orderId, orderId))).map((row) => row.status);
}

async function voucherRow(db: TestDatabase, id: string | null) {
  if (!id) throw new Error("no voucher");
  const [row] = await db.select().from(vouchers).where(eq(vouchers.id, id));
  return row;
}

async function movements(db: TestDatabase, sku: string) {
  return db.select().from(stockMovements).where(eq(stockMovements.sku, sku));
}

async function audits(db: TestDatabase, orderId: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityId, orderId), eq(auditLog.action, action)));
}

async function setFlags(db: TestDatabase, orderId: string, flags: OrderAttentionFlag[]) {
  await db.update(orders).set({ needsAttention: flags }).where(eq(orders.id, orderId));
}

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ActionError)) throw new Error(`expected an ActionError, got ${String(error)}`);
  return error;
}

/** Runs `fn` in a savepoint that is rolled back when it throws (a refused write never poisons the
 * test's own transaction). */
async function inSavepoint<T>(tx: TestDatabase, fn: (sp: TestDatabase) => Promise<T>): Promise<T> {
  return tx.transaction(async (sp) => fn(sp as unknown as TestDatabase));
}

// ---------- staff moves of checkout orders (transitionOrderStatus guard) ----------

describe("transitionOrderStatus for staff on checkout orders", () => {
  test("an unpaid checkout order cannot be moved to Siap Kirim or cancelled through the generic transition", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      expect((await rejection(inSavepoint(tx, (sp) => transitionOrderStatus(fixture.orderId, "to_ship", staff.id, sp)))).message).toBe(CHECKOUT_ORDER_UNPAID_MESSAGE);
      expect((await rejection(inSavepoint(tx, (sp) => transitionOrderStatus(fixture.orderId, "cancelled", staff.id, sp)))).message).toBe(CHECKOUT_ORDER_CANCEL_PATH_MESSAGE);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["active"]);

      const paid = await paidOrder(tx);
      expect((await rejection(inSavepoint(tx, (sp) => transitionOrderStatus(paid.orderId, "cancelled", staff.id, sp)))).message).toBe(CHECKOUT_ORDER_CANCEL_PATH_MESSAGE);
      // Shipping on is unchanged.
      await transitionOrderStatus(paid.orderId, "shipped", staff.id, tx, { courier: "JNE", trackingNumber: "JNE1" });
      expect((await orderRow(tx, paid.orderId)).status).toBe("shipped");
    });
  });

  test("manual orders (web channel included) move exactly as before", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant } = await insertProductVariant(tx);
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 2, valueAmount: 2 * UNIT_COST, type: "production", refType: "manual" });
      const today = new Date().toISOString().slice(0, 10);
      const toShip = await createOrder({ channelId: "web", orderDate: today, items: [{ sku: variant.sku, qty: 1, unitPrice: PRICE }], discountAmount: 0, shippingAmount: 0, status: "awaiting_payment" }, staff.id, tx);
      await transitionOrderStatus(toShip.id, "to_ship", staff.id, tx);
      const cancelled = await createOrder({ channelId: "shopee", channelOrderNo: `SHP-${randomInt(1_000_000)}`, orderDate: today, items: [{ sku: variant.sku, qty: 1, unitPrice: PRICE }], discountAmount: 0, shippingAmount: 0, status: "awaiting_payment" }, staff.id, tx);
      await transitionOrderStatus(cancelled.id, "cancelled", staff.id, tx);
      expect((await orderRow(tx, toShip.id)).status).toBe("to_ship");
      expect(await orderRow(tx, cancelled.id)).toMatchObject({ status: "cancelled", cancelReason: null, needsAttention: [] });
      expect((await rejection(cancelCheckoutOrderByStaff(tx, stubGateway(), toShip.id, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.notCheckout);
    });
  });

  test('"Proses" of an order paid while stock was short sells it once restocked and clears only that flag', async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { stock: 1 });
      await adjustStock({ sku: fixture.sku, deltaQty: -1, reason: "damaged" }, staff.id, tx);
      const gateway = stubGateway();
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));
      await handlePaymentNotification(tx, gateway, signed(statusBody(fixture.attempts[0]!, "settlement", fixture.total)));
      await setFlags(tx, fixture.orderId, ["stock_short_at_payment", "payment_anomaly"]);

      // Still short: refused with the SKU, nothing changes.
      await expect(inSavepoint(tx, (sp) => transitionOrderStatus(fixture.orderId, "to_ship", staff.id, sp))).rejects.toThrow(/tidak cukup/);
      await tx.insert(stockMovements).values({ sku: fixture.sku, qty: 1, valueAmount: UNIT_COST, type: "production", refType: "manual" });
      await transitionOrderStatus(fixture.orderId, "to_ship", staff.id, tx);

      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: ["payment_anomaly"] });
      expect((await movements(tx, fixture.sku)).filter((row) => row.type === "sale")).toHaveLength(1);
      const [transition] = await audits(tx, fixture.orderId, "transition_status").then((rows) => rows.filter((row) => row.actorStaffUserId === staff.id));
      expect(transition?.after).toMatchObject({ needsAttention: ["payment_anomaly"] });
    });
  });
});

// ---------- cancel ----------

describe("cancelCheckoutOrderByStaff", () => {
  test("unpaid, no transaction at the gateway: cancelled as admin, attempts ended, hold released, voucher back, audit-logged", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { voucher: true });
      const gateway = stubGateway();

      const result = await cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id);

      expect(result).toEqual({ outcome: "cancelled", refundDue: false, orderNo: fixture.orderNo, productSlugs: [fixture.slug] });
      expect(gateway.statusCalls).toEqual(fixture.attempts);
      expect(gateway.expireCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled", cancelReason: "admin", needsAttention: [] });
      expect((await attemptRows(tx, fixture.orderId)).map((row) => row.status)).toEqual(["cancelled"]);
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["released"]);
      expect(await voucherRow(tx, fixture.voucherId)).toMatchObject({ status: "active", usedOrderId: null });
      expect(await audits(tx, fixture.orderId, "transition_status")).toMatchObject([{ actorStaffUserId: staff.id }]);
      const [cancel] = await audits(tx, fixture.orderId, "cancel_checkout_order");
      expect(cancel).toMatchObject({ actorStaffUserId: staff.id, after: { cancelReason: "admin", paymentStatus: "cancelled", attemptsEnded: fixture.attempts, gateway: { [fixture.attempts[0]!]: "none" } } });
    });
  });

  test("unpaid, still pending at the gateway: every open attempt is expired there first and keeps the gateway's snapshot", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { attempts: 2 });
      const gateway = stubGateway();
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      gateway.answers.set(fixture.attempts[1]!, statusBody(fixture.attempts[1]!, "deny", fixture.total));

      await cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id);

      expect(gateway.expireCalls).toEqual([fixture.attempts[0]]);
      const attempts = await attemptRows(tx, fixture.orderId);
      expect(attempts.map((row) => row.status)).toEqual(["expired", "cancelled"]);
      expect(attempts[0]?.lastStatus).toMatchObject({ transaction_status: "expire" });
      expect(attempts[1]?.lastStatus).toMatchObject({ transaction_status: "deny" });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled", cancelReason: "admin" });
    });
  });

  test("unpaid, but the gateway says it was paid: the payment is applied and the cancel refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { voucher: true });
      const gateway = stubGateway();
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));

      expect((await rejection(cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.paidMeanwhile);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", cancelReason: null });
      expect(await voucherRow(tx, fixture.voucherId)).toMatchObject({ status: "used" });
    });
  });

  test("unpaid, gateway unreachable or refusing to expire a pending attempt: refused, nothing changes", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      const down = stubGateway();
      down.answers.set(fixture.attempts[0]!, "down");
      expect((await rejection(cancelCheckoutOrderByStaff(tx, down, fixture.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.gatewayUnavailable);

      const stuck = stubGateway();
      stuck.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      stuck.expireAnswers.set(fixture.attempts[0]!, "refuse");
      expect((await rejection(cancelCheckoutOrderByStaff(tx, stuck, fixture.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.stillPending);

      const expireDown = stubGateway();
      expireDown.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      expireDown.expireAnswers.set(fixture.attempts[0]!, "down");
      expect((await rejection(cancelCheckoutOrderByStaff(tx, expireDown, fixture.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.gatewayUnavailable);

      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", cancelReason: null });
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["active"]);
      expect(await audits(tx, fixture.orderId, "cancel_checkout_order")).toEqual([]);
    });
  });

  test("a gateway status that is neither paid, pending nor ended is refused with its own message (never 'already paid')", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      const gateway = stubGateway();
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "authorize", fixture.total));
      expect((await rejection(cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.checkGateway);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", needsAttention: ["payment_anomaly"] });
    });
  });

  test("the gateway calls of one cancel share a deadline: past it the cancel is refused before asking again", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { attempts: 3 });
      const gateway = stubGateway();
      gateway.delayMs = 40;
      expect((await rejection(cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id, { totalBudgetMs: 60 }))).message).toBe(STAFF_CANCEL_MESSAGES.gatewayUnavailable);
      expect(gateway.statusCalls.length).toBeLessThan(3);
      expect((await orderRow(tx, fixture.orderId)).status).toBe("awaiting_payment");
    });
  });

  test("without a payment configuration only paid orders can be cancelled", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const unpaid = await placedOrder(tx);
      expect((await rejection(cancelCheckoutOrderByStaff(tx, null, unpaid.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.noProvider);
      const paid = await paidOrder(tx);
      expect(await cancelCheckoutOrderByStaff(tx, null, paid.orderId, staff.id)).toMatchObject({ outcome: "cancelled", refundDue: true });
    });
  });

  test("paid (Siap Kirim): stock comes back, the voucher too (decision 44), flagged refund_due, other flags kept, no gateway call", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await paidOrder(tx, { voucher: true });
      await setFlags(tx, fixture.orderId, ["payment_anomaly"]);
      const gateway = stubGateway();

      const result = await cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id);

      expect(result).toEqual({ outcome: "cancelled", refundDue: true, orderNo: fixture.orderNo, productSlugs: [fixture.slug] });
      expect(gateway.statusCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "paid", cancelReason: "admin", needsAttention: ["payment_anomaly", "refund_due"] });
      const stock = await movements(tx, fixture.sku);
      expect(stock.reduce((sum, row) => sum + row.qty, 0)).toBe(3);
      expect(stock.filter((row) => row.type === "return")).toMatchObject([{ qty: 1, createdByStaffUserId: staff.id }]);
      expect(await voucherRow(tx, fixture.voucherId)).toMatchObject({ status: "active", usedOrderId: null });
      expect(await audits(tx, fixture.orderId, "cancel_checkout_order")).toMatchObject([{ actorStaffUserId: staff.id, after: { refundDue: true, cancelReason: "admin" } }]);
    });
  });

  test("paid while stock was short: hold released (nothing was sold), stock_short_at_payment resolved, refund_due added", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { stock: 1 });
      await adjustStock({ sku: fixture.sku, deltaQty: -1, reason: "damaged" }, staff.id, tx);
      const gateway = stubGateway();
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));
      await handlePaymentNotification(tx, gateway, signed(statusBody(fixture.attempts[0]!, "settlement", fixture.total)));
      expect((await orderRow(tx, fixture.orderId)).needsAttention).toEqual(["stock_short_at_payment"]);

      expect(await cancelCheckoutOrderByStaff(tx, gateway, fixture.orderId, staff.id)).toMatchObject({ outcome: "cancelled", refundDue: true });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "paid", cancelReason: "admin", needsAttention: ["refund_due"] });
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["released"]);
      expect((await movements(tx, fixture.sku)).filter((row) => row.type === "sale" || row.type === "return")).toEqual([]);
    });
  });

  test("an order already cancelled answers already_cancelled; a shipped one is refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      await cancelCheckoutOrderByStaff(tx, stubGateway(), fixture.orderId, staff.id);
      expect(await cancelCheckoutOrderByStaff(tx, stubGateway(), fixture.orderId, staff.id)).toMatchObject({ outcome: "already_cancelled" });
      expect(await audits(tx, fixture.orderId, "cancel_checkout_order")).toHaveLength(1);

      const shipped = await paidOrder(tx);
      await transitionOrderStatus(shipped.orderId, "shipped", staff.id, tx);
      expect((await rejection(cancelCheckoutOrderByStaff(tx, stubGateway(), shipped.orderId, staff.id))).message).toBe(STAFF_CANCEL_MESSAGES.notCancellable);
    });
  });

  test("a payment arriving after a staff cancel is paid_after_cancel + refund_due, nothing sold", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      await cancelCheckoutOrderByStaff(tx, stubGateway(), fixture.orderId, staff.id);
      const late = stubGateway();
      late.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));
      expect((await handlePaymentNotification(tx, late, signed(statusBody(fixture.attempts[0]!, "settlement", fixture.total)))).result).toBe("paid_after_cancel");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "paid", cancelReason: "admin", needsAttention: ["paid_after_cancel", "refund_due"] });
      expect((await movements(tx, fixture.sku)).filter((row) => row.type === "sale")).toEqual([]);
    });
  });
});

// ---------- refunds recorded by hand ----------

describe("recordManualRefund", () => {
  test("a cancelled paid order: attempt and order refunded, refund_due and paid_after_cancel cleared, other flags kept, audit has amount and note", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await paidOrder(tx);
      await cancelCheckoutOrderByStaff(tx, null, fixture.orderId, staff.id);
      await setFlags(tx, fixture.orderId, ["payment_anomaly", "paid_after_cancel", "refund_due"]);
      const [attempt] = await attemptRows(tx, fixture.orderId);

      const result = await recordManualRefund(tx, { orderId: fixture.orderId, paymentId: attempt!.id, note: "  Transfer BCA\n21/10  " }, staff.id);

      expect(result).toEqual({ orderNo: fixture.orderNo, amount: fixture.total, settled: true });
      expect((await attemptRows(tx, fixture.orderId))[0]).toMatchObject({ status: "refunded", refundedAmount: fixture.total });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "refunded", needsAttention: ["payment_anomaly"] });
      expect(await audits(tx, fixture.orderId, "record_refund")).toMatchObject([
        { actorStaffUserId: staff.id, after: { amount: fixture.total, note: "Transfer BCA 21/10", paymentStatus: "refunded", payment: { status: "refunded" } } },
      ]);

      // A second press records nothing.
      expect((await rejection(recordManualRefund(tx, { orderId: fixture.orderId, paymentId: attempt!.id, note: "lagi" }, staff.id))).message).toBe(REFUND_MESSAGES.noRefundDue);
      expect(await audits(tx, fixture.orderId, "record_refund")).toHaveLength(1);
    });
  });

  test("a duplicate payment on an order going ahead: the extra attempt is refunded, the order stays paid; the last paid attempt never is", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx, { attempts: 2 });
      const gateway = stubGateway();
      for (const id of fixture.attempts) {
        gateway.answers.set(id, statusBody(id, "settlement", fixture.total));
        await handlePaymentNotification(tx, gateway, signed(statusBody(id, "settlement", fixture.total)));
      }
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: ["refund_due"] });
      const [first, second] = await attemptRows(tx, fixture.orderId);

      expect(await recordManualRefund(tx, { orderId: fixture.orderId, paymentId: second!.id, note: "Refund dashboard QRIS" }, staff.id)).toMatchObject({ settled: true });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid", needsAttention: [] });

      await setFlags(tx, fixture.orderId, ["refund_due"]);
      expect((await rejection(recordManualRefund(tx, { orderId: fixture.orderId, paymentId: first!.id, note: "salah" }, staff.id))).message).toBe(REFUND_MESSAGES.lastPayment);
      expect((await attemptRows(tx, fixture.orderId))[0]?.status).toBe("paid");
    });
  });

  test("refused: no note, an unpaid attempt, another order's attempt, an order without refund_due", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await paidOrder(tx, { attempts: 2 });
      await cancelCheckoutOrderByStaff(tx, null, fixture.orderId, staff.id);
      const [paid, open] = await attemptRows(tx, fixture.orderId);
      expect((await rejection(recordManualRefund(tx, { orderId: fixture.orderId, paymentId: paid!.id, note: " " }, staff.id))).message).toBe(REFUND_MESSAGES.note);
      expect((await rejection(recordManualRefund(tx, { orderId: fixture.orderId, paymentId: open!.id, note: "Transfer" }, staff.id))).message).toBe(REFUND_MESSAGES.notPaid);
      const other = await paidOrder(tx);
      const [otherAttempt] = await attemptRows(tx, other.orderId);
      expect((await rejection(recordManualRefund(tx, { orderId: fixture.orderId, paymentId: otherAttempt!.id, note: "Transfer" }, staff.id))).message).toBe(REFUND_MESSAGES.notFound);
      expect((await rejection(recordManualRefund(tx, { orderId: other.orderId, paymentId: otherAttempt!.id, note: "Transfer" }, staff.id))).message).toBe(REFUND_MESSAGES.noRefundDue);
    });
  });
});

// ---------- flags ----------

describe("clearAttentionFlag", () => {
  test("clears exactly one flag, keeps the rest, audit-logged; a cleared flag cannot be cleared twice", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await paidOrder(tx);
      await setFlags(tx, fixture.orderId, ["amount_mismatch", "refund_received", "payment_anomaly"]);

      expect(await clearAttentionFlag(tx, fixture.orderId, "refund_received", staff.id)).toEqual({ orderNo: fixture.orderNo, needsAttention: ["amount_mismatch", "payment_anomaly"] });
      expect((await orderRow(tx, fixture.orderId)).needsAttention).toEqual(["amount_mismatch", "payment_anomaly"]);
      expect(await audits(tx, fixture.orderId, "clear_attention_flag")).toMatchObject([
        { actorStaffUserId: staff.id, before: { needsAttention: ["amount_mismatch", "refund_received", "payment_anomaly"] }, after: { cleared: "refund_received" } },
      ]);
      expect((await rejection(clearAttentionFlag(tx, fixture.orderId, "refund_received", staff.id))).message).toBe(FLAG_MESSAGES.alreadyCleared);
    });
  });

  test("refund_due and paid_after_cancel stay while money is still owed; once the gateway reports the refund they can be cleared", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      await cancelCheckoutOrderByStaff(tx, stubGateway(), fixture.orderId, staff.id);
      const gateway = stubGateway();
      const id = fixture.attempts[0]!;
      gateway.answers.set(id, statusBody(id, "settlement", fixture.total));
      await handlePaymentNotification(tx, gateway, signed(statusBody(id, "settlement", fixture.total)));
      for (const flag of ["refund_due", "paid_after_cancel"] as const) {
        expect((await rejection(inSavepoint(tx, (sp) => clearAttentionFlag(sp, fixture.orderId, flag, staff.id)))).message).toBe(FLAG_MESSAGES.refundOwed);
      }
      // Refunded from the Midtrans dashboard: the refund notification ends the owed money.
      gateway.answers.set(id, statusBody(id, "refund", fixture.total));
      await handlePaymentNotification(tx, gateway, signed(statusBody(id, "refund", fixture.total)));
      await clearAttentionFlag(tx, fixture.orderId, "refund_due", staff.id);
      await clearAttentionFlag(tx, fixture.orderId, "paid_after_cancel", staff.id);
      expect((await orderRow(tx, fixture.orderId)).needsAttention).toEqual(["refund_received"]);
    });
  });

  test("stock_short_at_payment stays while the order still waits for Proses or a cancel", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fixture = await placedOrder(tx);
      await setFlags(tx, fixture.orderId, ["stock_short_at_payment"]);
      expect((await rejection(clearAttentionFlag(tx, fixture.orderId, "stock_short_at_payment", staff.id))).message).toBe(FLAG_MESSAGES.stockShortOpen);
      expect((await orderRow(tx, fixture.orderId)).needsAttention).toEqual(["stock_short_at_payment"]);
    });
  });
});

// ---------- committed races ----------

describe("races (committed transactions)", () => {
  test("a staff cancel racing a settlement notification: either sold and the cancel refused, or cancelled + paid_after_cancel + refund_due; never a mix", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const staff = await insertStaffUser(testDb);
      const fixture = await placedOrder(testDb, { voucher: true });
      try {
        const id = fixture.attempts[0]!;
        // The cancel's gateway still sees no transaction; the notification's sees the settlement.
        const cancelGateway = stubGateway();
        cancelGateway.delayMs = round * 8;
        const notifyGateway = stubGateway();
        notifyGateway.answers.set(id, statusBody(id, "settlement", fixture.total));
        const [cancel] = await Promise.allSettled([
          cancelCheckoutOrderByStaff(testDb, cancelGateway, fixture.orderId, staff.id),
          handlePaymentNotification(testDb, notifyGateway, signed(statusBody(id, "settlement", fixture.total))),
        ]);

        const order = await orderRow(testDb, fixture.orderId);
        expect(order.paymentStatus).toBe("paid");
        const sales = (await movements(testDb, fixture.sku)).filter((row) => row.type === "sale");
        if (order.status === "cancelled") {
          outcomes.add("cancelled");
          expect(cancel.status).toBe("fulfilled");
          expect(order).toMatchObject({ cancelReason: "admin", needsAttention: ["paid_after_cancel", "refund_due"] });
          expect(sales).toHaveLength(0);
          expect(await holdStatuses(testDb, fixture.orderId)).toEqual(["released"]);
          expect(await voucherRow(testDb, fixture.voucherId)).toMatchObject({ status: "active" });
        } else {
          outcomes.add("sold");
          expect(cancel.status).toBe("rejected");
          expect(order).toMatchObject({ status: "to_ship", cancelReason: null, needsAttention: [] });
          expect(sales).toHaveLength(1);
          expect(await holdStatuses(testDb, fixture.orderId)).toEqual(["consumed"]);
          expect(await voucherRow(testDb, fixture.voucherId)).toMatchObject({ status: "used", usedOrderId: fixture.orderId });
        }
      } finally {
        await cleanUp([fixture], [staff.id]);
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  test("two staff clearing the same flag at once: one clears it, the other is told it is gone; one audit row", async () => {
    const staffA = await insertStaffUser(testDb);
    const staffB = await insertStaffUser(testDb);
    const fixture = await placedOrder(testDb);
    try {
      await setFlags(testDb, fixture.orderId, ["amount_mismatch", "payment_anomaly"]);
      const results = await Promise.allSettled([
        clearAttentionFlag(testDb, fixture.orderId, "payment_anomaly", staffA.id),
        clearAttentionFlag(testDb, fixture.orderId, "payment_anomaly", staffB.id),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ActionError);
      expect(((rejected as PromiseRejectedResult).reason as ActionError).message).toBe(FLAG_MESSAGES.alreadyCleared);
      expect((await orderRow(testDb, fixture.orderId)).needsAttention).toEqual(["amount_mismatch"]);
      expect(await audits(testDb, fixture.orderId, "clear_attention_flag")).toHaveLength(1);

      // Two different flags at once: both cleared, neither undoes the other.
      await setFlags(testDb, fixture.orderId, ["amount_mismatch", "payment_anomaly", "refund_received"]);
      await Promise.all([
        clearAttentionFlag(testDb, fixture.orderId, "payment_anomaly", staffA.id),
        clearAttentionFlag(testDb, fixture.orderId, "refund_received", staffB.id),
      ]);
      expect((await orderRow(testDb, fixture.orderId)).needsAttention).toEqual(["amount_mismatch"]);
    } finally {
      await cleanUp([fixture], [staffA.id, staffB.id]);
    }
  });

  test("two refunds recorded at once and two cancels at once: each happens once", async () => {
    const staffA = await insertStaffUser(testDb);
    const staffB = await insertStaffUser(testDb);
    const fixture = await paidOrder(testDb);
    try {
      const cancels = await Promise.all([
        cancelCheckoutOrderByStaff(testDb, null, fixture.orderId, staffA.id),
        cancelCheckoutOrderByStaff(testDb, null, fixture.orderId, staffB.id),
      ]);
      expect(cancels.map((result) => result.outcome).sort()).toEqual(["already_cancelled", "cancelled"]);
      expect((await movements(testDb, fixture.sku)).filter((row) => row.type === "return")).toHaveLength(1);
      expect(await audits(testDb, fixture.orderId, "cancel_checkout_order")).toHaveLength(1);

      const [attempt] = await attemptRows(testDb, fixture.orderId);
      const refunds = await Promise.allSettled([
        recordManualRefund(testDb, { orderId: fixture.orderId, paymentId: attempt!.id, note: "Transfer BCA" }, staffA.id),
        recordManualRefund(testDb, { orderId: fixture.orderId, paymentId: attempt!.id, note: "Transfer BCA" }, staffB.id),
      ]);
      expect(refunds.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await audits(testDb, fixture.orderId, "record_refund")).toHaveLength(1);
      expect(await orderRow(testDb, fixture.orderId)).toMatchObject({ paymentStatus: "refunded", needsAttention: [] });
    } finally {
      await cleanUp([fixture], [staffA.id, staffB.id]);
    }
  });
});

async function cleanUp(fixtures: Fixture[], staffIds: string[]): Promise<void> {
  const orderIds = fixtures.map((fixture) => fixture.orderId);
  const skus = fixtures.map((fixture) => fixture.sku);
  const voucherIds = fixtures.flatMap((fixture) => (fixture.voucherId ? [fixture.voucherId] : []));
  const customerIds = (await testDb.select({ id: orders.customerId }).from(orders).where(inArray(orders.id, orderIds))).map((row) => row.id).filter((id): id is string => id !== null);
  const providerOrderIds = fixtures.flatMap((fixture) => fixture.attempts);
  await testDb.delete(paymentNotifications).where(inArray(paymentNotifications.providerOrderId, providerOrderIds));
  const cardRows = voucherIds.length > 0 ? await testDb.select({ cardId: vouchers.cardId }).from(vouchers).where(inArray(vouchers.id, voucherIds)) : [];
  if (voucherIds.length > 0) await testDb.delete(vouchers).where(inArray(vouchers.id, voucherIds));
  const cardIds = cardRows.map((row) => row.cardId);
  const cardOrderIds = cardIds.length > 0 ? (await testDb.select({ orderId: thankYouCards.orderId }).from(thankYouCards).where(inArray(thankYouCards.id, cardIds))).map((row) => row.orderId) : [];
  if (cardIds.length > 0) await testDb.delete(thankYouCards).where(inArray(thankYouCards.id, cardIds));
  await testDb.delete(payments).where(inArray(payments.orderId, orderIds));
  await testDb.delete(stockReservations).where(inArray(stockReservations.orderId, orderIds));
  await testDb.delete(auditLog).where(inArray(auditLog.entityId, orderIds));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, skus)));
  await testDb.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
  await testDb.delete(orders).where(inArray(orders.id, [...orderIds, ...cardOrderIds]));
  if (customerIds.length > 0) await testDb.delete(customers).where(inArray(customers.id, customerIds));
  const variantRows = await testDb.select({ productId: productVariants.productId, colorId: productVariants.fabricColorId, fabricId: productVariants.fabricId }).from(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(products).where(inArray(products.id, variantRows.map((row) => row.productId)));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, variantRows.map((row) => row.colorId)));
  await testDb.delete(fabrics).where(inArray(fabrics.id, variantRows.map((row) => row.fabricId)));
  await testDb.delete(auditLog).where(inArray(auditLog.actorStaffUserId, staffIds));
  await testDb.delete(staffUsers).where(inArray(staffUsers.id, staffIds));
}
