import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { fabrics, fabricStockMovements } from "@ammari/db/schema";
import {
  getFabricBalance,
  getFabricColorBalance,
  listFabricColorBalances,
  listFabricStockLedger,
  recordFabricAdjustment,
  recordFabricPurchase,
  voidFabricPurchase,
} from "./fabric-stock";

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx
    .insert(fabrics)
    .values({ name: `Katun Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

describe("fabric stock — numeric (yards) qty, not integer", () => {
  test("getFabricBalance returns real numbers, not strings, for both qty (numeric) and valueAmount (bigint)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 12.5, totalAmountPaid: 625_000, purchasedAt: "2026-01-01" }, null, tx);
      const balance = await getFabricBalance(fabric.id, tx);
      expect(balance.qty).toBe(12.5);
      expect(typeof balance.qty).toBe("number");
      expect(balance.valueAmount).toBe(625_000);
      expect(typeof balance.valueAmount).toBe("number");
    });
  });

  test("a moving average across two purchases at different prices, with fractional yards", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 500_000, purchasedAt: "2026-01-01" }, null, tx); // 50k/yard
      await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 300_000, purchasedAt: "2026-02-01" }, null, tx); // 60k/yard
      const balance = await getFabricBalance(fabric.id, tx);
      expect(balance.qty).toBe(15);
      expect(balance.valueAmount).toBe(800_000);
      expect(balance.valueAmount / balance.qty).toBeCloseTo(53_333.33, 1);
    });
  });

  test("correction #1 holds for fractional yard consumption down to exactly zero", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 3, totalAmountPaid: 10, purchasedAt: "2026-01-01" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -1.5, reason: "other" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -1.5, reason: "other" }, null, tx);
      const balance = await getFabricBalance(fabric.id, tx);
      expect(balance.qty).toBe(0);
      expect(balance.valueAmount).toBe(0);
    });
  });

  test("rejects an adjustment that would drive yards below zero", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, tx);
      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -10, reason: "damaged" }, null, tx),
      ).rejects.toThrow(/negatif/);
    });
  });
});

describe("voidFabricPurchase (correction #2)", () => {
  test("succeeds when nothing followed the purchase", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const staff = await insertStaffUser(tx);
      const purchase = await recordFabricPurchase(
        { fabricId: fabric.id, qty: 20, totalAmountPaid: 1_000_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );
      await voidFabricPurchase(purchase.id, staff.id, tx);
      const balance = await getFabricBalance(fabric.id, tx);
      expect(balance.qty).toBe(0);
      expect(balance.valueAmount).toBe(0);
    });
  });

  test("is rejected once a consumption exists after the purchase", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const staff = await insertStaffUser(tx);
      const purchase = await recordFabricPurchase(
        { fabricId: fabric.id, qty: 20, totalAmountPaid: 1_000_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -5, reason: "other" }, staff.id, tx);
      await expect(voidFabricPurchase(purchase.id, staff.id, tx)).rejects.toThrow(/Sesuaikan stok/);
    });
  });

  // Required by the /purchases feature's own safety guarantee (its getPurchaseById only ever
  // returns type='purchase' rows — see lib/inventory/purchases.ts), but the void path itself
  // must independently reject a non-purchase movement id too, regardless of how it got there.
  test("voiding a movement that isn't type 'purchase' (an adjustment) is rejected", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const staff = await insertStaffUser(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 20, totalAmountPaid: 1_000_000, purchasedAt: "2026-01-01" }, staff.id, tx);
      const adjustment = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -1, reason: "damaged" }, staff.id, tx);

      await expect(voidFabricPurchase(adjustment.id, staff.id, tx)).rejects.toThrow(/Hanya transaksi pembelian/);
    });
  });
});

describe("fabric stock ledger", () => {
  test("listFabricStockLedger reports real numbers for running yards and value", async () => {
    // Real commits, not withRollback — see accessories.test.ts's identical comment: Postgres's
    // now() is frozen at transaction start, so two inserts sharing one transaction would tie on
    // created_at and fall back to a random-UUID id tiebreak that doesn't reflect insertion order.
    const fabric = await insertFabric(testDb);
    try {
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 500_000, purchasedAt: "2026-01-01" }, null, testDb);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -2.5, reason: "damaged" }, null, testDb);

      const { rows } = await listFabricStockLedger(fabric.id, undefined, undefined, testDb);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.type).toBe("adjustment");
      expect(rows[0]?.runningQty).toBe(7.5);
      expect(typeof rows[0]?.runningQty).toBe("number");
      expect(rows[1]?.type).toBe("purchase");
      expect(rows[1]?.runningQty).toBe(10);
    } finally {
      await withTriggerDisabled(testDb, "fabric_stock_movements", "prevent_fabric_stock_movement_mutation", () =>
        testDb.delete(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id)),
      );
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("fabric stock per colour bucket (migration 0046, docs/plans/fabric-colour-stock.md D1/D2)", () => {
  /** A raw ledger row in one bucket — S1 has no colour-aware write path yet, so the buckets are
   * seeded directly (adjustment rows need a reason; nothing else about them matters here). */
  async function insertBucketMovement(tx: TestDatabase, fabricId: string, fabricColorId: string | null, qty: number, valueAmount: number) {
    await tx.insert(fabricStockMovements).values({ fabricId, fabricColorId, qty, valueAmount, type: "adjustment", refType: "manual", reason: "recount" });
  }

  test("each colour is its own bucket, Tanpa warna (NULL) is one more, and the buckets sum to the unchanged fabric total", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      // Old-style colourless stock, exactly what every pre-0046 row is.
      await recordFabricPurchase({ fabricId: fabric.id, qty: 30, totalAmountPaid: 540_000, purchasedAt: "2026-10-01" }, null, tx);
      await insertBucketMovement(tx, fabric.id, sage.id, 10.5, 204_750); // 19.500/yard
      await insertBucketMovement(tx, fabric.id, mocca.id, 8, 168_000); // 21.000/yard
      await insertBucketMovement(tx, fabric.id, sage.id, -2.5, -48_750);

      const sageBalance = await getFabricColorBalance(fabric.id, sage.id, tx);
      expect(sageBalance).toEqual({ qty: 8, valueAmount: 156_000 });
      expect(typeof sageBalance.qty).toBe("number");
      expect(typeof sageBalance.valueAmount).toBe("number");
      // A1: each colour's own moving average.
      expect(sageBalance.valueAmount / sageBalance.qty).toBe(19_500);
      const moccaBalance = await getFabricColorBalance(fabric.id, mocca.id, tx);
      expect(moccaBalance.valueAmount / moccaBalance.qty).toBe(21_000);
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 30, valueAmount: 540_000 });

      const total = await getFabricBalance(fabric.id, tx);
      expect(total).toEqual({ qty: 30 + 8 + 8, valueAmount: 540_000 + 156_000 + 168_000 });

      // Another fabric's stock (colourless and coloured) never leaks into this fabric's buckets.
      const otherFabric = await insertFabric(tx);
      const otherColor = await insertFabricColor(tx, otherFabric.id, { name: "Sage" });
      await recordFabricPurchase({ fabricId: otherFabric.id, qty: 99, totalAmountPaid: 990_000, purchasedAt: "2026-10-01" }, null, tx);
      await insertBucketMovement(tx, otherFabric.id, otherColor.id, 7, 70_000);
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 30, valueAmount: 540_000 });
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 8, valueAmount: 156_000 });
      expect(await getFabricColorBalance(fabric.id, otherColor.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricBalance(fabric.id, tx)).toEqual(total);
    });
  });

  test("voiding a legacy purchase that carries a colour puts the exact negation back into THAT colour's bucket", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await recordFabricPurchase({ fabricId: fabric.id, qty: 4, totalAmountPaid: 80_000, purchasedAt: "2026-10-01" }, null, tx);
      const [colored] = await tx
        .insert(fabricStockMovements)
        .values({ fabricId: fabric.id, fabricColorId: sage.id, qty: 6, valueAmount: 117_000, type: "purchase", refType: "manual", purchasedAt: "2026-10-02" })
        .returning();

      const voidRow = await voidFabricPurchase(colored!.id, staff.id, tx);
      expect(voidRow.fabricColorId).toBe(sage.id);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 4, valueAmount: 80_000 });
    });
  });

  // The pre-0046-rows guarantee itself (existing rows untouched by the migration) lives in
  // packages/db/test/migration-0046.test.ts; this pins how the read side treats them.
  test("colourless rows read as the Tanpa warna bucket, and adding colours to the master leaves the fabric total unchanged", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 12.25, totalAmountPaid: 245_000, purchasedAt: "2026-10-01" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -2.25, reason: "damaged" }, null, tx);
      const totalBefore = await getFabricBalance(fabric.id, tx);

      // Adding colours to the master changes nothing about existing stock.
      await insertFabricColor(tx, fabric.id, { name: "Sage" });
      expect(await getFabricBalance(fabric.id, tx)).toEqual(totalBefore);
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual(totalBefore);
      const rows = await tx.select().from(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id));
      expect(rows.every((row) => row.fabricColorId === null)).toBe(true);
    });
  });

  test("a colour with no movements reads as zero, never as another bucket's stock", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 100_000, purchasedAt: "2026-10-01" }, null, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });

  test("listFabricColorBalances: active colours always, inactive only with history, Tanpa warna last and only with history", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage", hex: "#9CAF88" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      // Lowercase first letter on purpose: citext orders case-insensitively ("abu" < "Mocca").
      const retiredWithStock = await insertFabricColor(tx, fabric.id, { name: "abu", isActive: false });
      await insertFabricColor(tx, fabric.id, { name: "Lama", isActive: false });
      await insertBucketMovement(tx, fabric.id, sage.id, 4, 78_000);
      await insertBucketMovement(tx, fabric.id, retiredWithStock.id, 1.5, 30_000);

      // No colourless movement yet: no Tanpa warna row.
      let rows = await listFabricColorBalances(fabric.id, tx);
      expect(rows.map((row) => row.name)).toEqual(["abu", "Mocca", "Sage"]);
      expect(rows.find((row) => row.fabricColorId === mocca.id)).toMatchObject({ qty: 0, valueAmount: 0, hasMovements: false, isActive: true });
      expect(rows.find((row) => row.fabricColorId === sage.id)).toMatchObject({ qty: 4, valueAmount: 78_000, hasMovements: true, hex: "#9CAF88" });
      expect(rows.find((row) => row.fabricColorId === retiredWithStock.id)).toMatchObject({ isActive: false, qty: 1.5 });

      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 200_000, purchasedAt: "2026-10-01" }, null, tx);
      rows = await listFabricColorBalances(fabric.id, tx);
      expect(rows.at(-1)).toEqual({ fabricColorId: null, name: null, hex: null, isActive: true, hasMovements: true, qty: 10, valueAmount: 200_000 });
      const sum = rows.reduce((acc, row) => ({ qty: acc.qty + row.qty, valueAmount: acc.valueAmount + row.valueAmount }), { qty: 0, valueAmount: 0 });
      expect(sum).toEqual(await getFabricBalance(fabric.id, tx));
    });
  });

  test("a fabric with no colours lists only its Tanpa warna bucket (and nothing at all before any movement)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      expect(await listFabricColorBalances(fabric.id, tx)).toEqual([]);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 3, totalAmountPaid: 60_000, purchasedAt: "2026-10-01" }, null, tx);
      expect(await listFabricColorBalances(fabric.id, tx)).toEqual([
        { fabricColorId: null, name: null, hex: null, isActive: true, hasMovements: true, qty: 3, valueAmount: 60_000 },
      ]);
    });
  });
});
