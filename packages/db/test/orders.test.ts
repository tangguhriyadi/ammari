import { describe, expect, test } from "vitest";
import { orderSettlements } from "../src/schema";
import { withRollback } from "./helpers";
import { insertOrder } from "./fixtures";

describe("orders", () => {
  test("a duplicate (channel_id, channel_order_no) fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      await expect(
        insertOrder(tx, { channelId: order.channelId, channelOrderNo: order.channelOrderNo }),
      ).rejects.toThrow();
    });
  });

  test("total_amount must equal subtotal + shipping - discount", async () => {
    await withRollback(async (tx) => {
      await expect(
        insertOrder(tx, {
          subtotalAmount: 259_000,
          shippingAmount: 10_000,
          discountAmount: 0,
          totalAmount: 999_999, // wrong on purpose
        }),
      ).rejects.toThrow();
    });
  });

  test("total_amount matching the components succeeds", async () => {
    await withRollback(async (tx) => {
      await expect(
        insertOrder(tx, {
          subtotalAmount: 259_000,
          shippingAmount: 10_000,
          discountAmount: 20_000,
          totalAmount: 249_000,
        }),
      ).resolves.not.toThrow();
    });
  });
});

describe("order_settlements", () => {
  test("re-importing the same income row (same order + external_ref) fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const settlement = {
        orderId: order.id,
        externalRef: "TXN-123",
        settledAt: new Date(),
        grossAmount: 259_000,
        feeAmount: 46_620,
        netAmount: 212_380,
      };

      await tx.insert(orderSettlements).values(settlement);
      await expect(tx.insert(orderSettlements).values(settlement)).rejects.toThrow();
    });
  });

  test("a correction with a different external_ref for the same order succeeds", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      await tx.insert(orderSettlements).values({
        orderId: order.id,
        externalRef: "TXN-123",
        settledAt: new Date(),
        grossAmount: 259_000,
        feeAmount: 46_620,
        netAmount: 212_380,
      });

      await expect(
        tx.insert(orderSettlements).values({
          orderId: order.id,
          externalRef: "TXN-123-correction",
          settledAt: new Date(),
          grossAmount: 259_000,
          feeAmount: 40_000,
          netAmount: 219_000,
        }),
      ).resolves.not.toThrow();
    });
  });

  test("a negative correction row (refund clawback) succeeds", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      await tx.insert(orderSettlements).values({
        orderId: order.id,
        externalRef: "TXN-123",
        settledAt: new Date(),
        grossAmount: 259_000,
        feeAmount: 46_620,
        netAmount: 212_380,
      });

      // A later return clawing back the original payout: gross and net go negative, fee is a
      // refunded credit. Balance (net = gross - fee) still holds: -259000 - (-46620) = -212380.
      await expect(
        tx.insert(orderSettlements).values({
          orderId: order.id,
          externalRef: "TXN-123-refund",
          settledAt: new Date(),
          grossAmount: -259_000,
          feeAmount: -46_620,
          netAmount: -212_380,
        }),
      ).resolves.not.toThrow();
    });
  });
});
