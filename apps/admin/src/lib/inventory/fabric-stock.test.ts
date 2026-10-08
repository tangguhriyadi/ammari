import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { fabrics, fabricStockMovements } from "@ammari/db/schema";
import {
  getFabricBalance,
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
      await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -1.5, reason: "other" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -1.5, reason: "other" }, null, tx);
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
        recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -10, reason: "damaged" }, null, tx),
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
      await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -5, reason: "other" }, staff.id, tx);
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
      const adjustment = await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -1, reason: "damaged" }, staff.id, tx);

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
      await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -2.5, reason: "damaged" }, null, testDb);

      const { rows } = await listFabricStockLedger(fabric.id, undefined, testDb);
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
