import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { fabricColors, fabrics, products, productVariants, stockMovements } from "@ammari/db/schema";
import { adjustStock, getSkuDetail, listStockLedger, listStockOverview, saveStockCount } from "./queries";

async function seedStock(tx: TestDatabase, sku: string, qty: number) {
  await tx.insert(stockMovements).values({ sku, qty, type: "production", refType: "manual" });
}

describe("adjustStock", () => {
  test("a negative-going adjustment is rejected and no movement is recorded", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5);

      await expect(
        adjustStock({ sku: variant.sku, deltaQty: -10, reason: "damaged" }, staff.id, tx),
      ).rejects.toThrow(/negatif/);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1); // only the seed movement — the rejected adjustment never landed
    });
  });

  test("an adjustment that keeps stock at or above zero succeeds", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5);

      await adjustStock({ sku: variant.sku, deltaQty: -5, reason: "lost", note: "hilang saat packing" }, staff.id, tx);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(2);
      expect(movements.find((m) => m.type === "adjustment")?.reason).toBe("lost");
    });
  });

  test("two concurrent negative adjustments on the same SKU cannot together drive stock below zero", async () => {
    const { fabric, color, product, variant } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    await seedStock(testDb, variant.sku, 5);

    try {
      // Each adjustment alone (-3) is valid against a starting balance of 5, but both together
      // (-6) would go negative — the row lock in adjustStock must serialize these so the SECOND
      // one recomputes against the balance AFTER the first committed, not the stale starting 5.
      const outcomes = await Promise.allSettled([
        adjustStock({ sku: variant.sku, deltaQty: -3, reason: "damaged" }, staff.id, testDb),
        adjustStock({ sku: variant.sku, deltaQty: -3, reason: "damaged" }, staff.id, testDb),
      ]);
      const succeeded = outcomes.filter((o) => o.status === "fulfilled");
      const failed = outcomes.filter((o) => o.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const movements = await testDb.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const finalBalance = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
      expect(finalBalance).toBe(2); // 5 - 3, exactly one adjustment landed
    } finally {
      // stock_movements is append-only (migration 0008, prevent_stock_movement_mutation) — this
      // disposable fixture's own movements need the trigger-disabling helper rather than a plain
      // delete.
      await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
        testDb.delete(stockMovements).where(eq(stockMovements.sku, variant.sku)),
      );
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("saveStockCount", () => {
  test("only creates movements for SKUs whose physical count differs from the system count", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, product } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);

      // A second variant (same product) with a different starting stock.
      const [variantB] = await tx
        .insert(productVariants)
        .values({
          sku: `SKU-${product.id}-B`,
          productId: product.id,
          fabricId: fabric.id,
          fabricColorId: color.id,
          closure: product.closure,
          size: "S",
        })
        .returning();
      if (!variantB) throw new Error("failed to insert second variant fixture");

      const [variantA] = await tx.select().from(productVariants).where(eq(productVariants.productId, product.id)).limit(1);
      if (!variantA) throw new Error("expected the first variant fixture to exist");

      await seedStock(tx, variantA.sku, 10);
      await seedStock(tx, variantB.sku, 4);

      const { changedSkus } = await saveStockCount(
        product.id,
        [
          { sku: variantA.sku, physicalQty: 10 }, // unchanged
          { sku: variantB.sku, physicalQty: 6 }, // +2
        ],
        staff.id,
        tx,
      );

      expect(changedSkus).toEqual([variantB.sku]);

      const movementsA = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantA.sku));
      expect(movementsA).toHaveLength(1); // only the seed — no recount movement created

      const movementsB = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantB.sku));
      expect(movementsB).toHaveLength(2);
      const recount = movementsB.find((m) => m.type === "adjustment");
      expect(recount?.qty).toBe(2);
      expect(recount?.reason).toBe("recount");
    });
  });

  test("a duplicate SKU in the same submission is rejected outright, not silently double-applied", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10);

      // Each line looks individually valid (physicalQty: 0 >= 0), but BOTH referencing the same
      // SKU would — if not rejected — each compute their delta against the SAME starting
      // balance of 10, queuing two -10 movements and landing stock at -10. Must be rejected
      // before either movement is ever queued.
      await expect(
        saveStockCount(
          "irrelevant-since-rejected-before-the-product-lookup" as string,
          [
            { sku: variant.sku, physicalQty: 0 },
            { sku: variant.sku, physicalQty: 0 },
          ],
          staff.id,
          tx,
        ),
      ).rejects.toThrow(/lebih dari sekali/);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1); // only the seed — nothing was ever inserted
    });
  });
});

describe("read-path aggregates (real numbers, not stringified bigints)", () => {
  test("getSkuDetail's currentStock sums every movement correctly", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 10);
      await seedStock(tx, variant.sku, -3);

      const detail = await getSkuDetail(variant.sku, tx);
      expect(detail?.currentStock).toBe(7);
      expect(typeof detail?.currentStock).toBe("number");
    });
  });

  test("listStockOverview's currentStock matches getSkuDetail for the same SKU", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 4);

      const { rows } = await listStockOverview({ productId: product.id }, undefined, tx);
      const row = rows.find((r) => r.sku === variant.sku);
      expect(row?.currentStock).toBe(4);
      expect(typeof row?.currentStock).toBe("number");
    });
  });

  test("listStockLedger's running balance is correct across multiple movements, newest first", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const base = Date.now();
      await tx.insert(stockMovements).values([
        { sku: variant.sku, qty: 10, type: "production", refType: "manual", createdAt: new Date(base) },
        { sku: variant.sku, qty: -3, type: "sale", refType: "manual", createdAt: new Date(base + 1000) },
        { sku: variant.sku, qty: 2, type: "return", refType: "manual", createdAt: new Date(base + 2000) },
      ]);

      const { rows } = await listStockLedger(variant.sku, undefined, tx);
      // Newest first: +2 (balance 9) -> -3 (balance 7) -> +10 (balance 10).
      expect(rows.map((r) => r.qty)).toEqual([2, -3, 10]);
      expect(rows.map((r) => r.runningBalance)).toEqual([9, 7, 10]);
      expect(rows.every((r) => typeof r.runningBalance === "number")).toBe(true);
    });
  });
});
