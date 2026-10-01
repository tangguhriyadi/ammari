import { describe, expect, test } from "vitest";
import { vouchers } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";
import { insertCustomer, insertOrder, insertThankYouCard } from "./fixtures";

async function insertVoucher(
  tx: TestTx,
  cardId: string,
  customerId: string,
  overrides: Partial<typeof vouchers.$inferInsert> = {},
) {
  return tx
    .insert(vouchers)
    .values({
      cardId,
      customerId,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      ...overrides,
    })
    .returning();
}

describe("vouchers", () => {
  test("a second voucher for the same card fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const customer = await insertCustomer(tx);

      await insertVoucher(tx, card.id, customer.id);
      await expect(insertVoucher(tx, card.id, customer.id)).rejects.toThrow();
    });
  });

  test("the same voucher cannot be used on two orders", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const customer = await insertCustomer(tx);
      const otherOrder = await insertOrder(tx);
      const yetAnotherOrder = await insertOrder(tx);

      const [voucher] = await insertVoucher(tx, card.id, customer.id, {
        status: "used",
        usedOrderId: otherOrder.id,
        usedAt: new Date(),
      });
      if (!voucher) throw new Error("failed to insert voucher fixture");

      // Try to point a second voucher's used_order_id at an order already claimed by another
      // voucher's used_order_id — actually testing uniqueness requires reusing the SAME
      // used_order_id on a different voucher row.
      const card2 = await insertThankYouCard(tx, yetAnotherOrder.id);
      await expect(
        insertVoucher(tx, card2.id, customer.id, {
          status: "used",
          usedOrderId: otherOrder.id,
          usedAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  test("consistency CHECK: status='used' requires used_order_id", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const customer = await insertCustomer(tx);

      await expect(insertVoucher(tx, card.id, customer.id, { status: "used" })).rejects.toThrow();
    });
  });

  test("consistency CHECK: used_order_id and used_at set without status='used' fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const customer = await insertCustomer(tx);
      const usedOrder = await insertOrder(tx);

      await expect(
        insertVoucher(tx, card.id, customer.id, { usedOrderId: usedOrder.id, usedAt: new Date() }),
      ).rejects.toThrow();
    });
  });

  test("consistency CHECK: status='used' with used_order_id but no used_at fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const customer = await insertCustomer(tx);
      const usedOrder = await insertOrder(tx);

      await expect(
        insertVoucher(tx, card.id, customer.id, { status: "used", usedOrderId: usedOrder.id }),
      ).rejects.toThrow();
    });
  });
});
