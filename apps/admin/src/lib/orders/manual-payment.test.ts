import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { accounts, auditLog, journalEntries, journalLines, orderManualPayments, orders, stockMovements } from "@ammari/db/schema";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { transitionOrderStatus, type CreateOrderInput } from "@ammari/commerce/orders";
import { ActionError, FieldError } from "@/lib/errors";
import { ACCOUNT_MESSAGES } from "@/lib/accounting/account-input";
import { setAccountActive } from "@/lib/accounting/accounts";
import { MANUAL_PAYMENT_MESSAGES } from "./manual-payment-input";
import {
  assertPlainTransitionAllowed,
  confirmManualOrderPayment,
  createOrderWithManualPayment,
  getManualPaymentState,
  loadManualPaymentOptions,
  recordManualOrderPayment,
} from "./manual-payment";

// Session 6, D-3 (docs/plans/accounting.md §4.1 S6, §8 Session 6) against the real 0053 trigger in
// ammari_test: a manual order's payment method, Kas & Bank account and date are written in the
// same transaction as the order (or its "Siap Kirim"), corrected with an audit row, and never
// guessed. Every test rolls back.

const NOW = new Date("2026-12-10T05:00:00Z"); // 2026-12-10 in Jakarta
const TRANSFER = { method: "transfer" as const, cashAccountCode: "1-1201", paidOn: "2026-12-10" };
const CASH = { method: "cash" as const, cashAccountCode: "1-1101", paidOn: "2026-12-09" };

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

async function setup(tx: TestTx, stock = 10) {
  const { variant } = await insertProductVariant(tx);
  const staff = await insertStaffUser(tx);
  if (stock > 0) await tx.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * 100_000, type: "production", refType: "manual" });
  const orderInput = (overrides: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
    channelId: "whatsapp",
    orderDate: "2026-12-10",
    items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
    discountAmount: 0,
    shippingAmount: 0,
    status: "to_ship",
    ...overrides,
  });
  return { variant, staff, orderInput };
}

async function paymentRow(tx: TestTx, orderId: string) {
  const [row] = await tx.select().from(orderManualPayments).where(eq(orderManualPayments.orderId, orderId));
  return row;
}

async function orderCount(tx: TestTx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders);
  return row?.n ?? 0;
}

async function auditActions(tx: TestTx, orderId: string): Promise<string[]> {
  const rows = await tx
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, orderId)))
    .orderBy(auditLog.createdAt);
  return rows.map((row) => row.action);
}

describe("createOrderWithManualPayment (order form)", () => {
  test("a manual order created as Siap Kirim saves the order and its payment together, audited", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const order = await createOrderWithManualPayment(orderInput(), TRANSFER, staff.id, tx, NOW);
      const row = await paymentRow(tx, order.id);
      expect(row).toMatchObject({ method: "transfer", cashAccountCode: "1-1201", paidOn: "2026-12-10", recordedByStaffUserId: staff.id });
      expect(await auditActions(tx, order.id)).toEqual(expect.arrayContaining(["create", "record_manual_payment"]));
    });
  });

  test("each manual channel needs it: whatsapp, instagram, offline and a manual web order", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      for (const channelId of ["whatsapp", "instagram", "offline", "web"] as const) {
        const error = await rejection(createOrderWithManualPayment(orderInput({ channelId }), null, staff.id, tx, NOW));
        expect(error).toBeInstanceOf(ActionError);
        expect(error.message).toBe(MANUAL_PAYMENT_MESSAGES.required);
      }
    });
  });

  test("without a payment nothing is saved: no order, no stock movement", async () => {
    await withRollback(async (tx) => {
      const { variant, staff, orderInput } = await setup(tx);
      const before = await orderCount(tx);
      await rejection(createOrderWithManualPayment(orderInput(), null, staff.id, tx, NOW));
      expect(await orderCount(tx)).toBe(before);
      const sales = await tx.select().from(stockMovements).where(and(eq(stockMovements.sku, variant.sku), eq(stockMovements.type, "sale")));
      expect(sales).toHaveLength(0);
    });
  });

  test("a refused payment rolls the order back too (one transaction)", async () => {
    await withRollback(async (tx) => {
      const { variant, staff, orderInput } = await setup(tx);
      const before = await orderCount(tx);
      const future = await rejection(createOrderWithManualPayment(orderInput(), { ...TRANSFER, paidOn: "2026-12-11" }, staff.id, tx, NOW));
      expect(future).toBeInstanceOf(FieldError);
      expect(future.message).toBe(MANUAL_PAYMENT_MESSAGES.paidOnFuture);

      await tx.insert(accounts).values({ code: "1-1199", name: "Kas lama uji", type: "asset", normalBalance: "debit", parentCode: "1-1100", isActive: false, cashFlowGroup: "cash" });
      const inactive = await rejection(createOrderWithManualPayment(orderInput(), { ...TRANSFER, cashAccountCode: "1-1199" }, staff.id, tx, NOW));
      expect(inactive).toBeInstanceOf(FieldError);
      expect(inactive.message).toBe(MANUAL_PAYMENT_MESSAGES.accountNotAllowed);

      expect(await orderCount(tx)).toBe(before);
      const sales = await tx.select().from(stockMovements).where(and(eq(stockMovements.sku, variant.sku), eq(stockMovements.type, "sale")));
      expect(sales).toHaveLength(0);
    });
  });

  test("a stock refusal saves no payment either", async () => {
    await withRollback(async (tx) => {
      const { variant, staff, orderInput } = await setup(tx, 0);
      const error = await rejection(createOrderWithManualPayment(orderInput(), TRANSFER, staff.id, tx, NOW));
      expect(error.message).toContain(variant.sku);
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(orderManualPayments);
      expect(row?.n).toBe(0);
    });
  });

  test("an order waiting for payment, or a marketplace order, takes no payment record", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const waiting = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      expect(await paymentRow(tx, waiting.id)).toBeUndefined();
      const marketplace = await createOrderWithManualPayment(orderInput({ channelId: "shopee", channelOrderNo: "SHP123456" }), null, staff.id, tx, NOW);
      expect(await paymentRow(tx, marketplace.id)).toBeUndefined();

      expect((await rejection(createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), CASH, staff.id, tx, NOW))).message).toBe(MANUAL_PAYMENT_MESSAGES.notPaidYet);
      expect((await rejection(createOrderWithManualPayment(orderInput({ channelId: "tiktok", channelOrderNo: "TTK123456" }), CASH, staff.id, tx, NOW))).message).toBe(
        MANUAL_PAYMENT_MESSAGES.notManualOrder,
      );
    });
  });
});

describe("Siap Kirim on a manual order waiting for payment", () => {
  test("the plain status change is refused on the server", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const order = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      const error = await rejection(assertPlainTransitionAllowed(order.id, "to_ship", tx));
      expect(error.message).toBe(MANUAL_PAYMENT_MESSAGES.useConfirmPayment);
      // Other transitions are unaffected.
      await expect(assertPlainTransitionAllowed(order.id, "cancelled", tx)).resolves.toBeUndefined();
    });
  });

  test("a marketplace order's transitions are unaffected", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "to_ship" });
      await expect(assertPlainTransitionAllowed(order.id, "to_ship", tx)).resolves.toBeUndefined();
    });
  });

  test("a future payment date is refused before anything changes", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const order = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      const error = await rejection(confirmManualOrderPayment(order.id, { ...CASH, paidOn: "2026-12-11" }, staff.id, tx, NOW));
      expect(error).toBeInstanceOf(FieldError);
      const [after] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
      expect(after?.status).toBe("awaiting_payment");
    });
  });

  test("a checkout order's own transitions are unaffected", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { ...checkoutOrderValues(), status: "awaiting_payment" });
      await expect(assertPlainTransitionAllowed(order.id, "to_ship", tx)).resolves.toBeUndefined();
    });
  });

  test("confirming moves it to Siap Kirim and records the payment in one transaction", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const order = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      await confirmManualOrderPayment(order.id, CASH, staff.id, tx, NOW);
      const [after] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
      expect(after?.status).toBe("to_ship");
      expect(await paymentRow(tx, order.id)).toMatchObject({ method: "cash", cashAccountCode: "1-1101", paidOn: "2026-12-09" });
    });
  });

  test("a refused payment leaves the order waiting and its stock untouched", async () => {
    await withRollback(async (tx) => {
      const { variant, staff, orderInput } = await setup(tx);
      const order = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      await rejection(confirmManualOrderPayment(order.id, { ...CASH, cashAccountCode: "1-1200" }, staff.id, tx, NOW)); // a header
      const [after] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
      expect(after?.status).toBe("awaiting_payment");
      const sales = await tx.select().from(stockMovements).where(and(eq(stockMovements.sku, variant.sku), eq(stockMovements.type, "sale")));
      expect(sales).toHaveLength(0);
      expect(await paymentRow(tx, order.id)).toBeUndefined();
    });
  });
});

describe("Isi cara bayar (older orders)", () => {
  /** An order entered before the feature: created at to_ship straight through commerce, no row. */
  async function olderOrder(tx: TestTx) {
    const ctx = await setup(tx);
    const order = await createOrderWithManualPayment(ctx.orderInput({ status: "awaiting_payment" }), null, ctx.staff.id, tx, NOW);
    await transitionOrderStatus(order.id, "to_ship", ctx.staff.id, tx);
    return { ...ctx, order };
  }

  test("an older paid order shows as required with no record (a posting issue, never a default)", async () => {
    await withRollback(async (tx) => {
      const { order } = await olderOrder(tx);
      const state = await getManualPaymentState({ id: order.id, channelId: "whatsapp", status: "to_ship", isCheckout: false }, tx);
      expect(state).toEqual({ required: true, awaitingPayment: false, payment: null });
    });
  });

  test("filling it records the row; changing it updates it with before/after audit; saving the same is a no-op", async () => {
    await withRollback(async (tx) => {
      const { staff, order } = await olderOrder(tx);
      expect(await recordManualOrderPayment(order.id, CASH, staff.id, tx, NOW)).toEqual({ changed: true });
      expect(await recordManualOrderPayment(order.id, TRANSFER, staff.id, tx, NOW)).toEqual({ changed: true });
      expect(await recordManualOrderPayment(order.id, TRANSFER, staff.id, tx, NOW)).toEqual({ changed: false });
      expect(await paymentRow(tx, order.id)).toMatchObject(TRANSFER);

      const audits = await tx
        .select({ action: auditLog.action, before: auditLog.before, after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, order.id), sql`${auditLog.action} like '%manual_payment'`))
        .orderBy(auditLog.createdAt);
      expect(audits).toEqual([
        { action: "record_manual_payment", before: null, after: CASH },
        { action: "update_manual_payment", before: CASH, after: TRANSFER },
      ]);

      const state = await getManualPaymentState({ id: order.id, channelId: "whatsapp", status: "to_ship", isCheckout: false }, tx);
      expect(state?.payment).toMatchObject({ method: "transfer", cashAccountCode: "1-1201", cashAccountName: "Bank utama", paidOn: "2026-12-10" });
    });
  });

  test("still allowed after shipping and after a cancel that followed payment (the money came in)", async () => {
    await withRollback(async (tx) => {
      const { staff, order } = await olderOrder(tx);
      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);
      expect(await recordManualOrderPayment(order.id, CASH, staff.id, tx, NOW)).toEqual({ changed: true });
    });
  });

  test("refused for an order still waiting for payment, one cancelled before payment, a checkout and a marketplace order", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const waiting = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      expect((await rejection(recordManualOrderPayment(waiting.id, CASH, staff.id, tx, NOW))).message).toBe(MANUAL_PAYMENT_MESSAGES.notPaidYet);

      await transitionOrderStatus(waiting.id, "cancelled", staff.id, tx);
      expect((await rejection(recordManualOrderPayment(waiting.id, CASH, staff.id, tx, NOW))).message).toBe(MANUAL_PAYMENT_MESSAGES.cancelledBeforePayment);
      const cancelledState = await getManualPaymentState({ id: waiting.id, channelId: "whatsapp", status: "cancelled", isCheckout: false }, tx);
      expect(cancelledState?.required).toBe(false);

      const checkout = await insertOrder(tx, { ...checkoutOrderValues(), status: "to_ship" });
      expect((await rejection(recordManualOrderPayment(checkout.id, CASH, staff.id, tx, NOW))).message).toBe(MANUAL_PAYMENT_MESSAGES.notManualOrder);
      expect(await getManualPaymentState({ id: checkout.id, channelId: "web", status: "to_ship", isCheckout: true }, tx)).toBeNull();

      const marketplace = await insertOrder(tx, { status: "to_ship" });
      expect((await rejection(recordManualOrderPayment(marketplace.id, CASH, staff.id, tx, NOW))).message).toBe(MANUAL_PAYMENT_MESSAGES.notManualOrder);
    });
  });
});

describe("the 0053 trigger (the database is the real guard)", () => {
  async function savepoint(tx: TestTx, fn: (inner: TestTx) => Promise<unknown>): Promise<Error> {
    return rejection(tx.transaction(async (inner) => fn(inner as TestTx)));
  }

  test("refuses a marketplace or checkout order, an unpaid order, a non-cash, header or inactive account, and an order_id change", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      const paid = await createOrderWithManualPayment(orderInput(), TRANSFER, staff.id, tx, NOW);
      // Paid but without a row (an order from before the feature): the target of an order_id change.
      const other = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      await transitionOrderStatus(other.id, "to_ship", staff.id, tx);
      const waiting = await createOrderWithManualPayment(orderInput({ status: "awaiting_payment" }), null, staff.id, tx, NOW);
      const marketplace = await insertOrder(tx, { status: "to_ship" });
      const checkout = await insertOrder(tx, { ...checkoutOrderValues(), status: "to_ship" });
      const row = (orderId: string, cashAccountCode = "1-1201") => ({ orderId, method: "transfer" as const, cashAccountCode, paidOn: "2026-12-10", recordedByStaffUserId: staff.id });

      expect((await savepoint(tx, (inner) => inner.insert(orderManualPayments).values(row(marketplace.id)))).cause).toMatchObject({ constraint_name: "order_manual_payments_order" });
      expect((await savepoint(tx, (inner) => inner.insert(orderManualPayments).values(row(checkout.id)))).cause).toMatchObject({ constraint_name: "order_manual_payments_order" });
      expect((await savepoint(tx, (inner) => inner.insert(orderManualPayments).values(row(waiting.id)))).cause).toMatchObject({ constraint_name: "order_manual_payments_order" });
      expect((await savepoint(tx, (inner) => inner.update(orderManualPayments).set({ cashAccountCode: "1-1302" }).where(eq(orderManualPayments.orderId, paid.id)))).cause).toMatchObject({
        constraint_name: "order_manual_payments_cash_account_check",
      });
      expect((await savepoint(tx, (inner) => inner.update(orderManualPayments).set({ cashAccountCode: "1-1200" }).where(eq(orderManualPayments.orderId, paid.id)))).cause).toMatchObject({
        constraint_name: "order_manual_payments_account",
      });
      await tx.insert(accounts).values({ code: "1-1199", name: "Kas lama uji", type: "asset", normalBalance: "debit", parentCode: "1-1100", isActive: false, cashFlowGroup: "cash" });
      expect((await savepoint(tx, (inner) => inner.update(orderManualPayments).set({ cashAccountCode: "1-1199" }).where(eq(orderManualPayments.orderId, paid.id)))).cause).toMatchObject({
        constraint_name: "order_manual_payments_account",
      });
      expect((await savepoint(tx, (inner) => inner.delete(orderManualPayments).where(eq(orderManualPayments.orderId, paid.id)))).cause).toMatchObject({
        constraint_name: "order_manual_payments_no_delete",
      });
      expect((await savepoint(tx, (inner) => inner.update(orderManualPayments).set({ orderId: other.id }).where(eq(orderManualPayments.orderId, paid.id)))).cause).toMatchObject({
        constraint_name: "order_manual_payments_order",
      });
    });
  });

  test("an account unposted payments point at stays postable: never a header, deactivated only once S6 has posted them", async () => {
    await withRollback(async (tx) => {
      const { staff, orderInput } = await setup(tx);
      await tx.insert(accounts).values({ code: "1-1202", name: "Bank kedua uji", type: "asset", normalBalance: "debit", parentCode: "1-1200", cashFlowGroup: "cash" });
      const order = await createOrderWithManualPayment(orderInput(), { ...TRANSFER, cashAccountCode: "1-1202" }, staff.id, tx, NOW);

      const deactivate = () => savepoint(tx, (inner) => inner.update(accounts).set({ isActive: false }).where(eq(accounts.code, "1-1202")));
      expect((await deactivate()).cause).toMatchObject({ message: expect.stringContaining("manual-order payments not yet posted") });
      // The account editor (Data Master Akun) says why, in Indonesian.
      const editorError = await rejection(setAccountActive("1-1202", false, staff.id, tx));
      expect(editorError).toBeInstanceOf(ActionError);
      expect(editorError.message).toBe(ACCOUNT_MESSAGES.paymentsCannotDeactivate);
      expect((await savepoint(tx, (inner) => inner.update(accounts).set({ isHeader: true }).where(eq(accounts.code, "1-1202")))).cause).toMatchObject({
        message: expect.stringContaining("manual-order payments point at cannot become a header"),
      });

      // Once rule S6 (Session 9) has an active journal for the order, the account may be closed.
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          entryNo: "JU-202612-9901",
          entryDate: "2026-12-10",
          sourceDate: "2026-12-10",
          sourceType: "order",
          sourceId: order.id,
          sourceEvent: "collected",
          ruleVersion: 1,
          kind: "system",
          description: "Uji S6",
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values([
        { entryId: entry!.id, lineNo: 1, accountCode: "1-1202", debit: 259_000, credit: 0 },
        { entryId: entry!.id, lineNo: 2, accountCode: "2-1201", debit: 0, credit: 259_000 },
      ]);
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.code, "1-1202"));
      const [after] = await tx.select({ isActive: accounts.isActive }).from(accounts).where(eq(accounts.code, "1-1202"));
      expect(after?.isActive).toBe(false);
    });
  });
});

describe("loadManualPaymentOptions", () => {
  test("lists the active Kas & Bank accounts (Kas tunai, Bank utama) and suggests per method; card -> Bank utama", async () => {
    await withRollback(async (tx) => {
      const options = await loadManualPaymentOptions(tx);
      expect(options.accounts.map((account) => account.code)).toEqual(expect.arrayContaining(["1-1101", "1-1201"]));
      expect(options.accounts.every((account) => /^1-1[12]\d{2}$/.test(account.code))).toBe(true);
      expect(options.accounts.map((account) => account.code)).not.toContain("1-1200"); // header
      expect(options.suggestedAccount).toEqual({ cash: "1-1101", transfer: "1-1201", card: "1-1201" });

    });
  });

  test("leaves out an inactive account", async () => {
    await withRollback(async (tx) => {
      await tx.insert(accounts).values({ code: "1-1199", name: "Kas lama uji", type: "asset", normalBalance: "debit", parentCode: "1-1100", isActive: false, cashFlowGroup: "cash" });
      const options = await loadManualPaymentOptions(tx);
      expect(options.accounts.map((account) => account.code)).not.toContain("1-1199");
    });
  });
});
