import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { fabricColors, fabrics, products, productVariants, stockMovements } from "@ammari/db/schema";
import { adjustStock, getSkuDetail, listStockLedger, listStockOverview, saveStockCount } from "./queries";

async function seedStock(tx: TestDatabase, sku: string, qty: number, unitCost = 0) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: qty * unitCost, type: "production", refType: "manual" });
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

describe("adjustStock values movements at the current moving average", () => {
  test("a partial negative adjustment is valued at the current average, not re-derived later", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 1000); // 5 pcs @ Rp1.000 = Rp5.000 total value

      const movement = await adjustStock({ sku: variant.sku, deltaQty: -2, reason: "damaged" }, staff.id, tx);

      // valueDeltaForConsumption({qty:5, valueAmount:5000}, -2) = round(-2 * 1000) = -2000.
      expect(movement.valueAmount).toBe(-2000);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalValue = movements.reduce((sum, m) => sum + m.valueAmount, 0);
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(3);
      expect(totalValue).toBe(3000); // qty>0 => value>=0, and still exactly 3 * 1000
    });
  });

  test("an adjustment that brings qty to exactly zero clears the remaining value exactly, not a rounded amount", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      // 3 pcs @ a non-terminating-decimal average (10/3 per pcs) — the case correction #1 in
      // lib/inventory/moving-average.ts exists for. Inserted directly (not via seedStock, whose
      // qty*unitCost multiplication could itself introduce float drift here) so the balance is
      // exactly {qty: 3, valueAmount: 10}.
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 10, type: "production", refType: "manual" });

      const movement = await adjustStock({ sku: variant.sku, deltaQty: -3, reason: "lost" }, staff.id, tx);
      expect(movement.valueAmount).toBe(-10); // exactly -balance.valueAmount, not round(-3 * 10/3)

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalValue = movements.reduce((sum, m) => sum + m.valueAmount, 0);
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(0);
      expect(totalValue).toBe(0); // invariant: qty=0 => value=0, exactly
    });
  });

  test("a positive (found-stock) adjustment is valued at the current average, leaving it unchanged", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 1000); // avg Rp1.000/pcs

      const movement = await adjustStock({ sku: variant.sku, deltaQty: 5, reason: "other", note: "ditemukan" }, staff.id, tx);
      expect(movement.valueAmount).toBe(5000); // 5 * current average (1000), average unchanged

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalValue = movements.reduce((sum, m) => sum + m.valueAmount, 0);
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalValue / totalQty).toBe(1000);
    });
  });
});

describe("saveStockCount values recount movements at the current moving average", () => {
  test("a recount's movement is valued at that SKU's own current average", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, product } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const [variantB] = await tx
        .insert(productVariants)
        .values({ sku: `SKU-${product.id}-B`, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "S" })
        .returning();
      if (!variantB) throw new Error("failed to insert second variant fixture");
      const [variantA] = await tx.select().from(productVariants).where(eq(productVariants.productId, product.id)).limit(1);
      if (!variantA) throw new Error("expected the first variant fixture to exist");

      await seedStock(tx, variantA.sku, 10, 2000); // avg Rp2.000/pcs
      await seedStock(tx, variantB.sku, 4, 500); // avg Rp500/pcs — different SKUs, different averages

      await saveStockCount(
        product.id,
        [
          { sku: variantA.sku, physicalQty: 8 }, // -2 @ 2000 = -4000
          { sku: variantB.sku, physicalQty: 6 }, // +2 @ 500 = +1000
        ],
        staff.id,
        tx,
      );

      const movementsA = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantA.sku));
      const recountA = movementsA.find((m) => m.type === "adjustment");
      expect(recountA?.valueAmount).toBe(-4000);

      const movementsB = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantB.sku));
      const recountB = movementsB.find((m) => m.type === "adjustment");
      expect(recountB?.valueAmount).toBe(1000);
    });
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

      const { rows } = await listStockOverview({ productId: product.id }, undefined, undefined, tx);
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
        { sku: variant.sku, qty: 10, valueAmount: 0, type: "production", refType: "manual", createdAt: new Date(base) },
        { sku: variant.sku, qty: -3, valueAmount: 0, type: "sale", refType: "manual", createdAt: new Date(base + 1000) },
        { sku: variant.sku, qty: 2, valueAmount: 0, type: "return", refType: "manual", createdAt: new Date(base + 2000) },
      ]);

      const { rows } = await listStockLedger(variant.sku, undefined, undefined, tx);
      // Newest first: +2 (balance 9) -> -3 (balance 7) -> +10 (balance 10).
      expect(rows.map((r) => r.qty)).toEqual([2, -3, 10]);
      expect(rows.map((r) => r.runningBalance)).toEqual([9, 7, 10]);
      expect(rows.every((r) => typeof r.runningBalance === "number")).toBe(true);
    });
  });
});
