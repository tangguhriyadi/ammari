import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertThankYouCard, shippingQuoteValues } from "@ammari/db/test-fixtures";
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
import { withExclusiveRun } from "../maintenance/lock";
import { reserveStockForOrder } from "../stock/reservations";
import { handlePaymentNotification } from "./notification";
import { createFakePaymentProvider } from "./fake";
import { PaymentProviderError, type PaymentProvider, type PaymentStatusReport } from "./provider";
import { midtransSignature, parsePaymentStatusBody, verifyMidtransSignature } from "./status";
import { sweepExpiredPayments } from "./sweep";
import { fakeMidtransServerKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §6.3, D3, D13, session 12: the expiry sweep against the test
// database with a stub gateway (nothing reaches Midtrans). Unpaid orders past the payment window
// are checked attempt by attempt; after the stock hold they are expired at the gateway, or locally
// when the gateway has no live transaction (owner decisions 2026-10-21).

const KEY = fakeMidtransServerKey("sandbox", "SWEEP");
const PRICE = 259_000;
const UNIT_COST = 100_000;

// ---------- stub gateway ----------

type Answer = Record<string, unknown> | "down" | null;

interface StubGateway extends PaymentProvider {
  answers: Map<string, Answer>;
  /** What an expire call answers per id: "refuse" (412/404), "down", or (default) expire a
   * pending transaction like Midtrans does. */
  expireAnswers: Map<string, "refuse" | "down">;
  statusCalls: string[];
  expireCalls: string[];
  /** Waits this long in every call (to overlap two runs). */
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
  itemId: string;
  total: number;
  attempts: string[];
  voucherId: string | null;
}

/** A placed checkout order: one line, its stock held, `attempts` payment attempts (all with a
 * page), optionally a redeemed voucher. `window` places the payment deadline: "open" (still
 * payable), "hold" (window over, hold still running) or "over" (hold over too). */
async function placedOrder(
  db: TestDatabase,
  options: { window: "open" | "hold" | "over"; attempts?: number; voucher?: { expired?: boolean }; stock?: number },
): Promise<Fixture> {
  const { product, variant } = await insertProductVariant(db);
  const stock = options.stock ?? 3;
  await db.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * UNIT_COST, type: "production", refType: "manual" });
  const customer = await insertCustomer(db);
  const discount = options.voucher ? 20_000 : 0;
  const quote = shippingQuoteValues(95_000);
  const total = PRICE + (quote.shippingAmount ?? 0) - discount;
  const orderNo = `ORD-2099${String(randomInt(10, 99))}-${String(randomInt(10_000_000, 99_999_999))}`;
  // Far in the past so these orders come first in the sweep's oldest-first batch.
  const windowEnd = { open: 30 * 60_000, hold: -5 * 60_000, over: -(10 * 24 * 60 + 20) * 60_000 }[options.window];
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
    paymentExpiresAt: new Date(Date.now() + windowEnd),
  });
  const [item] = await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: PRICE, unitCost: 0 }).returning();
  if (!item) throw new Error("item fixture");
  await reserveStockForOrder(db as Tx, order.id, [{ orderItemId: item.id, sku: variant.sku, qty: 1 }], 75);
  // The hold ends 15 minutes after the window, like placeOrder's 60 / 75 minutes.
  await db.update(stockReservations).set({ expiresAt: new Date(Date.now() + windowEnd + 15 * 60_000) }).where(eq(stockReservations.orderId, order.id));

  let voucherId: string | null = null;
  if (options.voucher) {
    const card = await insertThankYouCard(db, (await insertOrder(db)).id, { status: "claimed", claimedByCustomerId: customer.id, claimedAt: new Date() });
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

  const attempts: string[] = [];
  for (let attempt = 1; attempt <= (options.attempts ?? 1); attempt += 1) {
    const providerOrderId = `SWEEP-${orderNo}-${attempt}`;
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
  return { orderId: order.id, orderNo, sku: variant.sku, slug: product.slug, itemId: item.id, total, attempts, voucherId };
}

async function orderRow(db: TestDatabase, id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order vanished");
  return row;
}

async function attemptStatuses(db: TestDatabase, orderId: string) {
  return (await db.select({ status: payments.status }).from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.attempt)).map((row) => row.status);
}

async function holdStatuses(db: TestDatabase, orderId: string) {
  return (await db.select({ status: stockReservations.status }).from(stockReservations).where(eq(stockReservations.orderId, orderId))).map((row) => row.status);
}

async function voucherStatus(db: TestDatabase, id: string | null) {
  if (!id) throw new Error("no voucher");
  const [row] = await db.select().from(vouchers).where(eq(vouchers.id, id));
  return row;
}

async function sales(db: TestDatabase, sku: string) {
  return db.select().from(stockMovements).where(and(eq(stockMovements.sku, sku), eq(stockMovements.type, "sale")));
}

function resultOf(summary: Awaited<ReturnType<typeof sweepExpiredPayments>>, fixture: Fixture) {
  return summary.results.find((row) => row.orderNo === fixture.orderNo)?.result;
}

// ---------- in rolled-back transactions ----------

describe("sweepExpiredPayments", () => {
  test("an order still inside its payment window is not a candidate (no gateway call)", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "open" });
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBeUndefined();
      expect(gateway.statusCalls).not.toContain(fixture.attempts[0]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("between the window and the end of the hold: status fetched, nothing expired, pieces still held", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "hold" });
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("within_hold");
      expect(gateway.statusCalls).toContain(fixture.attempts[0]);
      expect(gateway.expireCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["active"]);
    });
  });

  test("a late settlement inside the hold is paid (sale written, hold consumed)", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "hold" });
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "settlement", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("paid");
      expect(summary.productSlugs).toContain(fixture.slug);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid" });
      expect(await sales(tx, fixture.sku)).toHaveLength(1);
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["consumed"]);
    });
  });

  test("after the hold, a pending attempt is expired at the gateway: order cancelled, hold released, voucher restored, pages to revalidate", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", voucher: {} });
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("expired");
      expect(gateway.expireCalls).toEqual([fixture.attempts[0]]);
      expect(summary.productSlugs).toContain(fixture.slug);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      expect(await attemptStatuses(tx, fixture.orderId)).toEqual(["expired"]);
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["released"]);
      expect(await voucherStatus(tx, fixture.voucherId)).toMatchObject({ status: "active", usedOrderId: null, usedAt: null });
      expect(await sales(tx, fixture.sku)).toHaveLength(0);

      // A second run finds nothing left to do for it.
      const again = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(again, fixture)).toBeUndefined();
    });
  });

  test("no transaction at the gateway (the buyer never picked a method): expired locally, expired voucher stays expired", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", voucher: { expired: true } });
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("expired_locally");
      expect(gateway.expireCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      expect(await attemptStatuses(tx, fixture.orderId)).toEqual(["expired"]);
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["released"]);
      expect(await voucherStatus(tx, fixture.voucherId)).toMatchObject({ status: "expired", usedOrderId: null });
      // The cancel is audit-logged without a staff actor.
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, fixture.orderId), eq(auditLog.action, "transition_status")));
      expect(audits).toMatchObject([{ actorStaffUserId: null }]);
    });
  });

  test("every open attempt is checked, not only the latest: an older attempt's settlement pays the order", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", attempts: 2 });
      const [first, second] = fixture.attempts as [string, string];
      gateway.answers.set(first, statusBody(first, "settlement", fixture.total));
      gateway.answers.set(second, statusBody(second, "pending", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("paid");
      expect(gateway.statusCalls).toEqual(expect.arrayContaining([first, second]));
      expect(gateway.expireCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid" });
    });
  });

  test("an older attempt still pending at the gateway is expired too; its end alone never cancels, the local expiry does once nothing is live", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", attempts: 2 });
      const [first, second] = fixture.attempts as [string, string];
      gateway.answers.set(first, statusBody(first, "pending", fixture.total));
      // The latest attempt has no transaction.
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(gateway.expireCalls).toEqual([first]);
      expect(resultOf(summary, fixture)).toBe("expired_locally");
      expect(await attemptStatuses(tx, fixture.orderId)).toEqual(["expired", "expired"]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      expect(second).toBeTruthy();
    });
  });

  test("the latest attempt's gateway expiry cancels through the state machine; an older one already ended is not asked again", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", attempts: 2 });
      const [first, second] = fixture.attempts as [string, string];
      await tx.update(payments).set({ status: "expired" }).where(eq(payments.providerOrderId, first));
      gateway.answers.set(second, statusBody(second, "expire", fixture.total));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("expired");
      expect(gateway.statusCalls).not.toContain(first);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
    });
  });

  test("the gateway refuses the expire because it was just paid: the fresh status pays the order", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over" });
      const id = fixture.attempts[0]!;
      gateway.answers.set(id, statusBody(id, "pending", fixture.total));
      gateway.expireAnswers.set(id, "refuse");
      // The status fetch after the refusal sees the settlement.
      const original = gateway.getPaymentStatus.bind(gateway);
      let calls = 0;
      gateway.getPaymentStatus = async (providerOrderId, opts) => {
        calls += 1;
        if (calls === 2) gateway.answers.set(id, statusBody(id, "settlement", fixture.total));
        return original(providerOrderId, opts);
      };
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("paid");
      // Paid after its hold ran out: still sold (physical stock is there).
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "to_ship", paymentStatus: "paid" });
      expect(await sales(tx, fixture.sku)).toHaveLength(1);
    });
  });

  test("the gateway refuses the expire and still says pending: nothing is ended", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over" });
      const id = fixture.attempts[0]!;
      gateway.answers.set(id, statusBody(id, "pending", fixture.total));
      gateway.expireAnswers.set(id, "refuse");
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("gateway_pending");
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("a gateway that cannot be asked never ends an order (status or expire down)", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const down = await placedOrder(tx, { window: "over" });
      gateway.answers.set(down.attempts[0]!, "down");
      const expireDown = await placedOrder(tx, { window: "over" });
      gateway.answers.set(expireDown.attempts[0]!, statusBody(expireDown.attempts[0]!, "pending", expireDown.total));
      gateway.expireAnswers.set(expireDown.attempts[0]!, "down");
      // One attempt down and one without a transaction: still not ended.
      const mixed = await placedOrder(tx, { window: "over", attempts: 2 });
      gateway.answers.set(mixed.attempts[1]!, "down");

      const summary = await sweepExpiredPayments(tx, gateway);
      for (const fixture of [down, expireDown, mixed]) {
        expect(resultOf(summary, fixture)).toBe("gateway_unavailable");
        expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
        expect(await holdStatuses(tx, fixture.orderId)).toEqual(["active"]);
      }
    });
  });

  test("an order paid while stock was short is never a candidate: holds kept, never cancelled", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over" });
      await tx.update(orders).set({ paymentStatus: "paid", paidAt: new Date(), needsAttention: ["stock_short_at_payment"] }).where(eq(orders.id, fixture.orderId));
      await tx.update(payments).set({ status: "paid", paidAt: new Date() }).where(eq(payments.orderId, fixture.orderId));
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBeUndefined();
      expect(gateway.statusCalls).not.toContain(fixture.attempts[0]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "paid", needsAttention: ["stock_short_at_payment"] });
      expect(await holdStatuses(tx, fixture.orderId)).toEqual(["active"]);
    });
  });

  test("manual and marketplace orders are never touched (payment_status null)", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const manual = await insertOrder(tx, { status: "awaiting_payment" });
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(summary.results.find((row) => row.orderNo === manual.orderNo)).toBeUndefined();
      expect(await orderRow(tx, manual.id)).toMatchObject({ status: "awaiting_payment", paymentStatus: null });
    });
  });

  test("an order without any payment attempt (none should exist) is expired locally after its hold", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const fixture = await placedOrder(tx, { window: "over", attempts: 0 });
      const summary = await sweepExpiredPayments(tx, gateway);
      expect(resultOf(summary, fixture)).toBe("expired_locally");
      expect(gateway.statusCalls).toEqual(expect.not.arrayContaining([expect.stringContaining(fixture.orderNo)]));
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
    });
  });

  test("the local expiry re-checks the hold under the order lock: a live hold keeps the order open", async () => {
    await withRollback(async (tx) => {
      const fixture = await placedOrder(tx, { window: "hold" });
      const { expireOrderWithoutLiveTransaction } = await import("./apply-status");
      expect(await expireOrderWithoutLiveTransaction(tx, fixture.orderId, fixture.attempts)).toMatchObject({ outcome: "unchanged" });
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("an order the sweep cannot end is logged as an error once it is hours past its window; flagged orders are swept last", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const flagged = await placedOrder(tx, { window: "over" });
      await tx.update(orders).set({ needsAttention: ["payment_anomaly"], paymentExpiresAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) }).where(eq(orders.id, flagged.orderId));
      gateway.answers.set(flagged.attempts[0]!, "down");
      const plain = await placedOrder(tx, { window: "over" });
      const summary = await sweepExpiredPayments(tx, gateway);
      const order = summary.results.map((row) => row.orderNo);
      expect(order.indexOf(plain.orderNo)).toBeLessThan(order.indexOf(flagged.orderNo));
      expect(resultOf(summary, flagged)).toBe("gateway_unavailable");
      expect(summary.stuck).toBeGreaterThanOrEqual(1);
      expect(errors).toHaveBeenCalledWith(
        "[payments] sweep: order still unpaid and open long after its payment window; check it",
        expect.objectContaining({ orderNo: flagged.orderNo, result: "gateway_unavailable" }),
      );
    });
  });

  test("the time budget also stops inside an order (deferred, retried next run)", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const fixture = await placedOrder(tx, { window: "over" });
      gateway.answers.set(fixture.attempts[0]!, statusBody(fixture.attempts[0]!, "pending", fixture.total));
      // The clock passes the budget right after the order was started.
      let calls = 0;
      const summary = await sweepExpiredPayments(tx, gateway, { batchSize: 500, timeBudgetMs: 1_000, now: () => (calls++ < 2 ? 0 : 5_000) });
      expect(resultOf(summary, fixture) ?? "deferred").toBe("deferred");
      expect(summary.truncated).toBe(true);
      expect(gateway.expireCalls).toEqual([]);
      expect(await orderRow(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("the batch size and time budget stop a run early and say so", async () => {
    await withRollback(async (tx) => {
      const gateway = stubGateway();
      await placedOrder(tx, { window: "over" });
      await placedOrder(tx, { window: "over" });
      const batch = await sweepExpiredPayments(tx, gateway, { batchSize: 1 });
      expect(batch).toMatchObject({ candidates: 1, truncated: true });
      let clock = 0;
      const timed = await sweepExpiredPayments(tx, gateway, { timeBudgetMs: 10, now: () => (clock += 20) });
      expect(timed.truncated).toBe(true);
      expect(timed.results).toHaveLength(0);
    });
  });
});

describe("withExclusiveRun", () => {
  test("while one cron job holds the lock every other run (same or other job) is skipped; released with its transaction", async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    // `run` only starts once the lock is held: no timing assumption.
    const first = withExclusiveRun(testDb, "paymentSweep", async () => {
      started();
      await blocker;
      return "first";
    });
    await running;
    expect(await withExclusiveRun(testDb, "paymentSweep", async () => "second")).toEqual({ ran: false });
    expect(await withExclusiveRun(testDb, "retention", async () => "other job")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "first" });
    expect(await withExclusiveRun(testDb, "retention", async () => "third")).toEqual({ ran: true, value: "third" });
  });

  test("an error in the run releases the lock and is thrown to the caller", async () => {
    await expect(withExclusiveRun(testDb, "paymentSweep", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withExclusiveRun(testDb, "paymentSweep", async () => 1)).toEqual({ ran: true, value: 1 });
  });
});

// ---------- committed transactions: real concurrency ----------

describe("concurrency", () => {
  test("two sweep runs at once: one runs, one is skipped; the order is expired once", async () => {
    const fixture = await placedOrder(testDb, { window: "over", voucher: {} });
    try {
      const gateway = stubGateway();
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      // The first run waits inside the gateway until the second has been answered.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let inside: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const original = gateway.getPaymentStatus.bind(gateway);
      gateway.getPaymentStatus = async (id, opts) => {
        inside();
        await gate;
        return original(id, opts);
      };
      const firstRun = withExclusiveRun(testDb, "paymentSweep", () => sweepExpiredPayments(testDb, gateway));
      await entered;
      const second = await withExclusiveRun(testDb, "paymentSweep", () => sweepExpiredPayments(testDb, gateway));
      release();
      const first = await firstRun;
      expect([first.ran, second.ran]).toEqual([true, false]);
      gateway.getPaymentStatus = original;
      expect(await orderRow(testDb, fixture.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
      const cancels = await testDb.select().from(auditLog).where(and(eq(auditLog.entityId, fixture.orderId), eq(auditLog.action, "transition_status")));
      expect(cancels).toHaveLength(1);
      expect(await holdStatuses(testDb, fixture.orderId)).toEqual(["released"]);
      expect(await voucherStatus(testDb, fixture.voucherId)).toMatchObject({ status: "active" });

      // Even without the lock (two web slots on different databases cannot happen, but a bug
      // could), two runs never cancel twice: every write is conditional under the order lock.
      const unlocked = await placedOrder(testDb, { window: "over", voucher: {} });
      try {
        await Promise.all([sweepExpiredPayments(testDb, gateway), sweepExpiredPayments(testDb, gateway)]);
        expect(await orderRow(testDb, unlocked.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
        const unlockedCancels = await testDb.select().from(auditLog).where(and(eq(auditLog.entityId, unlocked.orderId), eq(auditLog.action, "transition_status")));
        expect(unlockedCancels).toHaveLength(1);
      } finally {
        await cleanUp([unlocked]);
      }
    } finally {
      await cleanUp([fixture]);
    }
  });

  test("a settlement notification racing the sweep's local expiry: either sold, or cancelled + paid_after_cancel; never a mix", async () => {
    for (let round = 0; round < 4; round += 1) {
      const fixture = await placedOrder(testDb, { window: "over", voucher: {} });
      try {
        const id = fixture.attempts[0]!;
        // The sweep's gateway has no transaction yet; the notification's (a moment later) has the settlement.
        const sweepGateway = stubGateway();
        sweepGateway.delayMs = round * 10;
        const notifyGateway = stubGateway();
        notifyGateway.answers.set(id, statusBody(id, "settlement", fixture.total));
        const body = signed(statusBody(id, "settlement", fixture.total));
        await Promise.all([sweepExpiredPayments(testDb, sweepGateway), handlePaymentNotification(testDb, notifyGateway, body)]);

        const order = await orderRow(testDb, fixture.orderId);
        expect(order.paymentStatus).toBe("paid");
        if (order.status === "cancelled") {
          expect(order.needsAttention).toEqual(["paid_after_cancel", "refund_due"]);
          expect(await sales(testDb, fixture.sku)).toHaveLength(0);
          expect(await holdStatuses(testDb, fixture.orderId)).toEqual(["released"]);
          expect(await voucherStatus(testDb, fixture.voucherId)).toMatchObject({ status: "active" });
        } else {
          expect(order.status).toBe("to_ship");
          expect(order.needsAttention).toEqual([]);
          expect(await sales(testDb, fixture.sku)).toHaveLength(1);
          expect(await holdStatuses(testDb, fixture.orderId)).toEqual(["consumed"]);
          expect(await voucherStatus(testDb, fixture.voucherId)).toMatchObject({ status: "used", usedOrderId: fixture.orderId });
        }
      } finally {
        await cleanUp([fixture]);
      }
    }
  });
});

async function cleanUp(fixtures: Fixture[]): Promise<void> {
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
}
