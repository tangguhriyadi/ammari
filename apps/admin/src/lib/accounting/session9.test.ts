import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runPosting, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { cancelCheckoutOrderByStaff, recordManualRefund, applyPaymentStatus } from "@ammari/commerce/payments";
import { createOrder, transitionOrderStatus } from "@ammari/commerce/orders";
import { auditLog, fiscalPeriods, paymentNotifications, journalEntries, journalLines, orderItems, payments, postingIssues, shipments, stockMovements } from "@ammari/db/schema";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { createOrderWithManualPayment, recordManualOrderPayment } from "@/lib/orders/manual-payment";
import { getReconciliation } from "./reconciliation";

// Session 9 through the app's REAL order, payment and refund write paths (docs/plans/accounting.md
// §4.1-§4.3, §6.3): createOrder / Session 6's payment record, transitionOrderStatus,
// applyPaymentStatus (a verified gateway status, no API call), cancelCheckoutOrderByStaff and
// recordManualRefund. The ledger only reads these records. stock_movements and audit_log stamp the
// database's own now(), so the runner posts from an early start date here; order timestamps follow
// the faked JS clock. Every test rolls back.

afterEach(() => {
  vi.useRealTimers();
});

function setNow(iso: string) {
  vi.useFakeTimers({ now: new Date(iso), toFake: ["Date"] });
}

const START = "2020-01-01";

/** Migration 0056's journal_entries_entry_date_floor_check refuses entries before 1 Dec 2026. These
 * tests go through the real write paths, which stamp some times with the DATABASE clock (`now()`:
 * a sale movement's created_at, a payment's paid_at) that the fake JS timers cannot move. While the
 * real clock is still before the books start, those fixtures would be dated before them, so the
 * floor alone is lifted inside this rolled-back transaction (DDL is transactional: the rollback
 * restores it; files run serially, so the table lock blocks no other suite). From 1 Dec 2026 on
 * this is a no-op and the full constraint applies. The floor itself is tested in
 * packages/db/test/migration-0056.test.ts. */
async function liftDateFloorBeforeBooksStart(tx: TestTx) {
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  await tx.execute(sql`
    do $$ begin
      if now() < date '2026-12-01' then
        alter table journal_entries drop constraint if exists journal_entries_entry_date_floor_check;
      end if;
    end $$`);
}

async function postAll(tx: TestTx) {
  await liftDateFloorBeforeBooksStart(tx);
  const result = await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", postingStartDate: START });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

/** A SKU with 10 pcs on the shelf at 87.917 each. */
async function setup(tx: TestTx) {
  const { variant } = await insertProductVariant(tx);
  const staff = await insertStaffUser(tx);
  await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 879_170, type: "production", refType: "manual" });
  return { variant, staff };
}

/** Every journal (active, superseded, reversals) of one key, oldest first, as "Dr/Cr code amount". */
async function journalsFor(tx: TestTx, sourceType: string, sourceId: string, sourceEvent: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId), eq(journalEntries.sourceEvent, sourceEvent)))
    .orderBy(asc(journalEntries.createdAt), asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)) };
    }),
  );
}

/** Σ (debit − credit) per account over every line carrying this order's id. */
async function orderNet(tx: TestTx, orderId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ code: journalLines.accountCode, net: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
    .from(journalLines)
    .where(eq(journalLines.orderId, orderId))
    .groupBy(journalLines.accountCode);
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]));
}

async function openIssues(tx: TestTx, sourceId: string) {
  return tx.select({ code: postingIssues.issueCode, event: postingIssues.sourceEvent }).from(postingIssues).where(and(eq(postingIssues.sourceId, sourceId), isNull(postingIssues.resolvedAt)));
}

/** A checkout order (1 pcs at 270.000, voucher 20.000, courier 24.000 with a 10.000 subsidy) and its
 * pending payment attempt, paid through the verified-status state machine. */
async function paidCheckoutOrder(tx: TestTx, sku: string) {
  const order = await insertOrder(tx, {
    ...checkoutOrderValues(),
    subtotalAmount: 270_000,
    discountAmount: 20_000,
    shippingAmount: 14_000,
    shippingCostAmount: 24_000,
    shippingSubsidyAmount: 10_000,
    totalAmount: 264_000,
  });
  await tx.insert(orderItems).values({ orderId: order.id, sku, qty: 1, unitPrice: 270_000, unitCost: 0 });
  const providerOrderId = `AMR-${randomUUID().slice(0, 8)}`;
  const [attempt] = await tx.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: 264_000, status: "pending" }).returning();
  const applied = await applyPaymentStatus(tx as never, {
    providerOrderId,
    transactionStatus: "settlement",
    transactionId: `tx-${providerOrderId}`,
    paymentType: "bank_transfer",
    grossAmount: 264_000,
    currency: "IDR",
    fraudStatus: "accept",
    refundAmount: null,
    snapshot: { transaction_status: "settlement" },
  });
  expect(applied?.outcome).toBe("paid");
  return { order, payment: attempt! };
}

describe("Session 9 sales posting against the real write paths", () => {
  test("web: paid → shipped (booked courier) → returned; idempotent; 1-1504 + 1-1505 follow the stock ledger", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-03T03:00:00Z");
      const { order, payment } = await paidCheckoutOrder(tx, variant.sku);
      await tx.insert(shipments).values({
        orderId: order.id,
        attempt: 1,
        referenceId: `REF-${order.orderNo}-K1`,
        provider: "biteship",
        providerOrderId: `bs-${randomUUID()}`,
        courier: "jne",
        service: "reg",
        costAmount: 25_000,
        status: "picked_up",
        bookedAt: new Date("2026-12-04T02:00:00Z"),
      });
      setNow("2026-12-05T03:00:00Z");
      await transitionOrderStatus(order.id, "shipped", staff.id, tx as never, { courier: "JNE", trackingNumber: "JNE123" });

      const first = await postAll(tx);
      expect(first.failedCount).toBe(0);
      expect((await journalsFor(tx, "payment", payment.id, "paid"))[0]?.sides).toEqual(["Dr 1-1301 264000", "Cr 2-1201 264000"]);
      const s3 = await journalsFor(tx, "order", order.id, "recognised");
      expect(s3).toHaveLength(1);
      expect(s3[0]?.entryDate).toBe("2026-12-05");
      expect(s3[0]?.sides).toEqual(["Dr 2-1201 264000", "Dr 4-1201 20000", "Dr 5-1101 87917", "Cr 4-1101 270000", "Cr 2-1203 14000", "Cr 1-1505 87917"]);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.orderId, order.id));
      expect((await journalsFor(tx, "shipment", shipment!.id, "charged"))[0]?.sides).toEqual(["Dr 2-1203 14000", "Dr 6-1302 10000", "Dr 6-1301 1000", "Cr 1-1603 25000"]);

      // Running again changes nothing.
      const second = await postAll(tx);
      expect(second.insertedCount).toBe(0);
      expect(second.reversedCount).toBe(0);

      setNow("2026-12-10T03:00:00Z");
      await transitionOrderStatus(order.id, "returned", staff.id, tx as never);
      await postAll(tx);
      expect((await journalsFor(tx, "order", order.id, "returned"))[0]?.sides).toEqual(["Dr 4-1301 270000", "Dr 6-1301 14000", "Cr 4-1201 20000", "Cr 2-1202 264000"]);

      const net = await orderNet(tx, order.id);
      expect(net["1-1505"]).toBe(0);
      expect(net["2-1201"]).toBe(0);
      expect(net["2-1203"]).toBe(0);
      expect(net["5-1101"]).toBe(0);
      // The order's own stock rows (sale + return) and its 1-1504 lines agree.
      const [stock] = await tx
        .select({ value: sql<string>`coalesce(sum(${stockMovements.valueAmount}), 0)` })
        .from(stockMovements)
        .innerJoin(orderItems, sql`${stockMovements.refId} = ${orderItems.id}::text`)
        .where(and(eq(orderItems.orderId, order.id), eq(stockMovements.refType, "order_item")));
      expect(net["1-1504"]).toBe(Number(stock!.value));
    });
  });

  test("web: paid → cancelled by staff → refund recorded by hand [D-9]", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-03T03:00:00Z");
      const { order, payment } = await paidCheckoutOrder(tx, variant.sku);
      setNow("2026-12-04T03:00:00Z");
      const cancelled = await cancelCheckoutOrderByStaff(tx as never, null, order.id, staff.id);
      expect(cancelled).toMatchObject({ outcome: "cancelled", refundDue: true });
      setNow("2026-12-06T03:00:00Z");
      await recordManualRefund(tx as never, { orderId: order.id, paymentId: payment.id, note: "BCA 6 Des" }, staff.id);
      // In real life the refund is its own transaction, days after the cancel; inside this one test
      // transaction the database's now() is frozen at its start, so the audit row gets its real time.
      await tx.update(auditLog).set({ createdAt: new Date() }).where(and(eq(auditLog.action, "record_refund"), eq(auditLog.entityId, order.id)));

      await postAll(tx);
      expect((await journalsFor(tx, "order", order.id, "cancelled_paid"))[0]?.sides).toEqual(["Dr 2-1201 264000", "Cr 2-1202 264000"]);
      expect((await journalsFor(tx, "payment", payment.id, "refunded"))[0]?.sides).toEqual(["Dr 2-1202 264000", "Cr 1-1201 264000"]);
      const net = await orderNet(tx, order.id);
      for (const code of ["1-1505", "2-1201", "2-1202", "1-1504"]) expect(net[code] ?? 0, code).toBe(0);
      expect(net["1-1301"]).toBe(264_000);
      expect((await postAll(tx)).insertedCount).toBe(0);
    });
  });

  test("manual: S6 on paid_on then S3 on the ship date; a record corrected after January closed lands in February", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2027-01-06T03:00:00Z");
      const order = await createOrderWithManualPayment(
        { channelId: "whatsapp", orderDate: "2027-01-05", items: [{ sku: variant.sku, qty: 1, unitPrice: 270_000 }], discountAmount: 0, shippingAmount: 15_000, status: "to_ship" },
        { method: "transfer", cashAccountCode: "1-1201", paidOn: "2027-01-05" },
        staff.id,
        tx as never,
      );
      await transitionOrderStatus(order.id, "shipped", staff.id, tx as never);
      await postAll(tx);
      const s6 = await journalsFor(tx, "order", order.id, "collected");
      expect(s6[0]?.entryDate).toBe("2027-01-05");
      expect(s6[0]?.sides).toEqual(["Dr 1-1201 285000", "Cr 2-1201 285000"]);
      expect((await journalsFor(tx, "order", order.id, "recognised"))[0]?.entryDate).toBe("2027-01-06");

      await tx.insert(fiscalPeriods).values({ month: "2027-01-01", status: "closed", closedAt: new Date(), closedByStaffUserId: staff.id });
      setNow("2027-02-03T03:00:00Z");
      await recordManualOrderPayment(order.id, { method: "cash", cashAccountCode: "1-1101", paidOn: "2027-01-04" }, staff.id, tx as never);
      const run = await postAll(tx);
      expect(run.reversedCount).toBeGreaterThanOrEqual(1);
      const after = await journalsFor(tx, "order", order.id, "collected");
      expect(after).toHaveLength(3);
      const [original, reversal, repost] = after;
      expect(original?.reversedByEntryId).toBe(reversal?.id);
      expect(reversal?.entryDate).toBe("2027-02-01");
      expect(repost?.entryDate).toBe("2027-02-01");
      expect(repost?.sourceDate).toBe("2027-01-04");
      expect(repost?.sides).toEqual(["Dr 1-1101 285000", "Cr 2-1201 285000"]);
      const net = await orderNet(tx, order.id);
      expect(net["2-1201"]).toBe(0);
      expect(net["1-1201"] ?? 0).toBe(0);
      expect(net["1-1101"]).toBe(285_000);
    });
  });

  test("manual: no payment record → manual_payment_missing; filling it in posts S6 and resolves the issue", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-08T03:00:00Z");
      // createOrder itself (a caller that skips the admin's payment step, plan §8.1).
      const order = await createOrder({ channelId: "instagram", orderDate: "2026-12-08", items: [{ sku: variant.sku, qty: 1, unitPrice: 250_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, tx as never);
      await postAll(tx);
      expect(await openIssues(tx, order.id)).toEqual([{ code: "manual_payment_missing", event: "collected" }]);
      expect(await journalsFor(tx, "order", order.id, "collected")).toEqual([]);

      await recordManualOrderPayment(order.id, { method: "card", cashAccountCode: "1-1201", paidOn: "2026-12-08" }, staff.id, tx as never);
      await postAll(tx);
      expect(await openIssues(tx, order.id)).toEqual([]);
      expect((await journalsFor(tx, "order", order.id, "collected"))[0]?.sides).toEqual(["Dr 1-1201 250000", "Cr 2-1201 250000"]);
    });
  });

  test("manual cancel held behind a missing payment record follows it once the record exists", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-08T03:00:00Z");
      const order = await createOrder({ channelId: "offline", orderDate: "2026-12-08", items: [{ sku: variant.sku, qty: 1, unitPrice: 250_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, tx as never);
      await transitionOrderStatus(order.id, "cancelled", staff.id, tx as never);
      await postAll(tx);
      expect(await journalsFor(tx, "order", order.id, "cancelled_paid")).toEqual([]);
      expect((await openIssues(tx, order.id)).map((issue) => issue.code)).toEqual(["manual_payment_missing"]);

      await recordManualOrderPayment(order.id, { method: "cash", cashAccountCode: "1-1101", paidOn: "2026-12-08" }, staff.id, tx as never);
      await postAll(tx);
      expect((await journalsFor(tx, "order", order.id, "cancelled_paid"))[0]?.sides).toEqual(["Dr 2-1201 250000", "Cr 2-1202 250000"]);
      const net = await orderNet(tx, order.id);
      expect(net["2-1201"]).toBe(0);
      expect(net["1-1505"]).toBe(0);
    });
  });

  test("marketplace: no real ship date stored yet (Session 5) → marketplace_ship_date_missing, fees held, never the import time", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-08T03:00:00Z");
      const order = await createOrder({ channelId: "shopee", channelOrderNo: `SP-${randomUUID().slice(0, 8)}`, orderDate: "2026-12-07", items: [{ sku: variant.sku, qty: 1, unitPrice: 250_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, tx as never);
      await transitionOrderStatus(order.id, "shipped", staff.id, tx as never);
      await postAll(tx);
      expect((await openIssues(tx, order.id)).map((issue) => issue.code)).toEqual(["marketplace_ship_date_missing"]);
      expect(await journalsFor(tx, "order", order.id, "recognised")).toEqual([]);
      expect(await journalsFor(tx, "order", order.id, "channel_fees")).toEqual([]);
      const net = await orderNet(tx, order.id);
      // S1 posted (the goods left at import); they wait in 1-1505 until recognition.
      expect(net["1-1505"]).toBeGreaterThan(0);
    });
  });

  test("a gateway refund is dated by its first verified notification, not by payments.updated_at", async () => {
    await withRollback(async (tx) => {
      const providerOrderId = `AMR-${randomUUID().slice(0, 8)}`;
      const order = await insertOrder(tx, { ...checkoutOrderValues(), status: "cancelled", paymentStatus: "refunded", paidAt: new Date("2026-12-03T03:00:00Z"), cancelledAt: new Date("2026-12-04T03:00:00Z"), totalAmount: 259_000, subtotalAmount: 259_000, shippingAmount: 0, shippingCostAmount: 12_000, shippingSubsidyAmount: 12_000 });
      const [attempt] = await tx
        .insert(payments)
        .values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: 259_000, status: "refunded", refundedAmount: 259_000, paidAt: new Date("2026-12-03T03:00:00Z") })
        .returning();
      await tx.insert(paymentNotifications).values([
        { providerOrderId, transactionStatus: "refund", signatureValid: true, payload: {}, receivedAt: new Date("2026-12-07T03:00:00Z") },
        // A forged or broken notification never dates anything.
        { providerOrderId, transactionStatus: "refund", signatureValid: false, payload: {}, receivedAt: new Date("2026-12-05T03:00:00Z") },
      ]);
      await postAll(tx);
      const [refund] = await journalsFor(tx, "payment", attempt!.id, "gateway_refunded");
      expect(refund?.sourceDate).toBe("2026-12-07");
      expect(refund?.sides).toEqual(["Dr 2-1202 259000", "Cr 1-1301 259000"]);
      expect((await journalsFor(tx, "order", order.id, "cancelled_paid"))[0]?.sides).toEqual(["Dr 2-1201 259000", "Cr 2-1202 259000"]);
    });
  });

  test("Rekonsiliasi checks 1 (1-1505), 3 and 3c list the order's open balances and agree with the journals", async () => {
    await withRollback(async (tx) => {
      const { variant } = await setup(tx);
      // Written directly with explicit December dates (the write paths stamp the database clock).
      const paidAt = new Date("2026-12-03T03:00:00Z");
      const order = await insertOrder(tx, { ...checkoutOrderValues(), status: "to_ship", paymentStatus: "paid", paidAt, subtotalAmount: 270_000, discountAmount: 20_000, shippingAmount: 14_000, shippingCostAmount: 24_000, shippingSubsidyAmount: 10_000, totalAmount: 264_000 });
      const [item] = await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 270_000, unitCost: 87_917 }).returning();
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: -1, valueAmount: -87_917, type: "sale", refType: "order_item", refId: item!.id, createdAt: paidAt });
      await tx.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId: `AMR-${randomUUID().slice(0, 8)}`, attempt: 1, grossAmount: 264_000, status: "paid", paidAt });
      await tx.insert(shipments).values({ orderId: order.id, attempt: 1, referenceId: `REF-${order.orderNo}-K1`, provider: "biteship", providerOrderId: `bs-${randomUUID()}`, courier: "jne", service: "reg", costAmount: 25_000, status: "pickup_requested", bookedAt: new Date("2026-12-04T02:00:00Z") });
      await postAll(tx);

      const report = await getReconciliation("2026-12-31", tx as never, 30_000);
      const row = (kind: string) => report.salesChecks.find((check) => check.kind === kind)?.rows.find((r) => r.orderId === order.id);
      expect(row("deposit")).toMatchObject({ app: 264_000, ledger: 264_000, difference: 0, status: "ok" });
      expect(row("sold_not_shipped")).toMatchObject({ app: 87_917, ledger: 87_917, difference: 0, status: "ok" });
      // Booked before shipping: the titipan is used up before S3 credits it (-14.000 until shipped).
      expect(row("buyer_shipping")).toMatchObject({ app: -14_000, ledger: -14_000, difference: 0 });
      expect(report.biteship.typed).toBe(30_000);
      expect(report.biteship.difference).toBe(30_000 - report.biteship.ledger);
    });
  });
});
