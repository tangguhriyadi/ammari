import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { stockMovements } from "../src/schema";
import { withRollback } from "./helpers";
import { insertProductVariant } from "./fixtures";

describe("stock_movements", () => {
  test("a sale and a later return for the same order_item both succeed", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const refId = randomUUID();

      await expect(
        tx.insert(stockMovements).values({
          sku: variant.sku,
          qty: -1,
          valueAmount: -10_000,
          type: "sale",
          refType: "order_item",
          refId,
        }),
      ).resolves.not.toThrow();

      // Same ref_id (same order_item), different type — must be allowed, not blocked by the
      // partial unique index.
      await expect(
        tx.insert(stockMovements).values({
          sku: variant.sku,
          qty: 1,
          valueAmount: 10_000,
          type: "return",
          refType: "order_item",
          refId,
        }),
      ).resolves.not.toThrow();
    });
  });

  test("a second sale movement for the same order_item fails", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const refId = randomUUID();

      await tx.insert(stockMovements).values({
        sku: variant.sku,
        qty: -1,
        valueAmount: -10_000,
        type: "sale",
        refType: "order_item",
        refId,
      });

      await expect(
        tx.insert(stockMovements).values({
          sku: variant.sku,
          qty: -1,
          valueAmount: -10_000,
          type: "sale",
          refType: "order_item",
          refId,
        }),
      ).rejects.toThrow();
    });
  });
});
