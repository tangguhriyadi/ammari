import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabrics, fabricStockMovements } from "@ammari/db/schema";
import {
  getFabricBalance,
  getFabricColorBalance,
  isAdjustableBucket,
  listFabricColorBalancesByFabric,
  listFabricStockLedger,
  parseFabricColorFilter,
  recordFabricAdjustment,
  recordFabricPurchase,
} from "./fabric-stock";

// docs/plans/fabric-colour-stock.md S4: adjustments per colour bucket (A1: each bucket's own
// moving average) and the per-colour reads behind /stock/fabrics, /stock/fabrics/[id], /fabrics/[id].

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx
    .insert(fabrics)
    .values({ name: `Marbella Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

/** Coloured stock the way a goods receipt writes it (a 'purchase' row carrying the colour); the
 * receipt path itself is covered by lib/receipts/colour.test.ts. */
async function stockIn(tx: TestDatabase, fabricId: string, fabricColorId: string, qty: number, valueAmount: number) {
  await tx.insert(fabricStockMovements).values({ fabricId, fabricColorId, qty, valueAmount, type: "purchase", refType: "manual", purchasedAt: "2026-11-01" });
}

describe("recordFabricAdjustment per colour bucket", () => {
  test("a reduction is valued at THAT colour's average, not the fabric's, and lands in that bucket", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      await stockIn(tx, fabric.id, sage.id, 10, 195_000); // 19.500/yard
      await stockIn(tx, fabric.id, mocca.id, 10, 300_000); // 30.000/yard; fabric average 24.750

      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -2, reason: "damaged" }, null, tx);
      expect(movement.fabricColorId).toBe(sage.id);
      expect(movement.valueAmount).toBe(-39_000);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 8, valueAmount: 156_000 });
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 10, valueAmount: 300_000 });
    });
  });

  test("refuses taking a colour below zero even when the fabric total stays positive", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await recordFabricPurchase({ fabricId: fabric.id, qty: 30, totalAmountPaid: 540_000, purchasedAt: "2026-10-01" }, null, tx);
      await stockIn(tx, fabric.id, sage.id, 2, 39_000);

      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -3, reason: "lost" }, null, tx),
      ).rejects.toThrow("Stok Sage tidak boleh menjadi negatif (stok sekarang 2.00 yard).");
      // The colourless bucket is a bucket too: 30 yard there, not 32.
      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -31, reason: "lost" }, null, tx),
      ).rejects.toThrow("Stok Tanpa warna tidak boleh menjadi negatif (stok sekarang 30.00 yard).");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 32, valueAmount: 579_000 });
    });
  });

  test("zero-residual rule per bucket: emptying a colour clears exactly its value and nothing else", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      await stockIn(tx, fabric.id, sage.id, 3, 10); // 3.33/yard: rounding residue on purpose
      await stockIn(tx, fabric.id, mocca.id, 1, 7);

      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -1.5, reason: "other" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -1.5, reason: "other" }, null, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 1, valueAmount: 7 });
    });
  });

  // Balances come back from SUM(numeric) as exact 2-decimal values, so `balance + (-balance)` is an
  // exact 0 here; the cent rounding in recordFabricAdjustment is a defensive guard, not something
  // this test can make fail. What it pins is the end state: an emptied bucket has value 0.
  test("fractional yards that sum to exactly the bucket still hit the zero-residual rule", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await stockIn(tx, fabric.id, sage.id, 0.3, 10);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -0.1, reason: "other" }, null, tx);
      await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -0.2, reason: "other" }, null, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });

  test("an increase into an active colour with no stock yet is allowed and valued at 0", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: 4.5, reason: "recount" }, null, tx);
      expect(movement).toMatchObject({ fabricColorId: sage.id, valueAmount: 0 });
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 4.5, valueAmount: 0 });
    });
  });

  test("Tanpa warna: refused when the fabric has active colours and that bucket is empty; allowed while it holds stock", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: 5, reason: "recount" }, null, tx),
      ).rejects.toThrow(`Pilih warna untuk ${fabric.name}.`);

      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 200_000, purchasedAt: "2026-10-01" }, null, tx);
      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: -4, reason: "recount" }, null, tx);
      expect(movement).toMatchObject({ fabricColorId: null, valueAmount: -80_000 });
    });
  });

  test("Tanpa warna is the only bucket of a fabric without (active) colours, even before any movement", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await insertFabricColor(tx, fabric.id, { name: "Lama", isActive: false });
      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: null, deltaQty: 2, reason: "recount" }, null, tx);
      expect(movement.fabricColorId).toBeNull();
    });
  });

  test("an inactive colour can be corrected only while its bucket is non-zero", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const retired = await insertFabricColor(tx, fabric.id, { name: "Abu", isActive: false });
      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: retired.id, deltaQty: 1, reason: "recount" }, null, tx),
      ).rejects.toThrow("Warna Abu sudah nonaktif dan tidak punya stok.");

      await stockIn(tx, fabric.id, retired.id, 2, 40_000);
      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: retired.id, deltaQty: -2, reason: "recount" }, null, tx);
      expect(movement.valueAmount).toBe(-40_000);
    });
  });

  test("a colour of another fabric is refused, never read as an empty bucket", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const other = await insertFabric(tx);
      const foreign = await insertFabricColor(tx, other.id, { name: "Sage" });
      await expect(
        recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: foreign.id, deltaQty: 1, reason: "recount" }, null, tx),
      ).rejects.toThrow("Warna tidak ditemukan untuk bahan ini.");
    });
  });

  test("a delta Postgres could not store as numeric(10,2) is refused before anything is written", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const adjust = (deltaQty: number) => recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty, reason: "recount" }, null, tx);
      await expect(adjust(-0.004)).rejects.toThrow("Maksimal 2 desimal.");
      await expect(adjust(100_000_000)).rejects.toThrow("Jumlah terlalu besar.");
      await expect(adjust(0)).rejects.toThrow("Jumlah tidak boleh 0.");
      await expect(adjust(Number.NaN)).rejects.toThrow("Jumlah tidak boleh 0.");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });

  test("two concurrent reductions a colour can afford only once: exactly one is written", async () => {
    // Real commits (not withRollback): the race is between two transactions, serialized by the
    // fabric row lock. Disposable fixtures, removed in `finally`.
    const fabric = await insertFabric(testDb);
    const sage = await insertFabricColor(testDb, fabric.id, { name: "Sage" });
    try {
      await stockIn(testDb, fabric.id, sage.id, 5, 97_500);
      const reduce = () => recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -3, reason: "lost" }, null, testDb);
      const results = await Promise.allSettled([reduce(), reduce()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(String((rejected as PromiseRejectedResult).reason)).toContain("Stok Sage tidak boleh menjadi negatif (stok sekarang 2.00 yard).");
      expect(await getFabricColorBalance(fabric.id, sage.id, testDb)).toEqual({ qty: 2, valueAmount: 39_000 });
    } finally {
      const movements = await testDb.select({ id: fabricStockMovements.id }).from(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id));
      for (const movement of movements) await testDb.delete(auditLog).where(eq(auditLog.entityId, movement.id));
      await withTriggerDisabled(testDb, "fabric_stock_movements", "prevent_fabric_stock_movement_mutation", () =>
        testDb.delete(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id)),
      );
      await testDb.delete(fabricColors).where(eq(fabricColors.fabricId, fabric.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });

  test("the audit entry carries the colour id and name", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      await stockIn(tx, fabric.id, sage.id, 5, 97_500);
      const movement = await recordFabricAdjustment({ fabricId: fabric.id, fabricColorId: sage.id, deltaQty: -1, reason: "damaged" }, staff.id, tx);

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "fabric_stock_movement"), eq(auditLog.entityId, movement.id), eq(auditLog.action, "adjust")));
      expect(entry?.after).toMatchObject({ fabricColorId: sage.id, colorName: "Sage", qty: -1, valueAmount: -19_500 });
    });
  });
});

describe("isAdjustableBucket", () => {
  test("active colour always; inactive and Tanpa warna only with a non-zero balance (or Tanpa warna for a colourless fabric)", () => {
    expect(isAdjustableBucket({ fabricColorId: "c", isActive: true, qty: 0 }, true)).toBe(true);
    expect(isAdjustableBucket({ fabricColorId: "c", isActive: false, qty: 0 }, true)).toBe(false);
    expect(isAdjustableBucket({ fabricColorId: "c", isActive: false, qty: 1.5 }, true)).toBe(true);
    expect(isAdjustableBucket({ fabricColorId: null, isActive: true, qty: 0 }, true)).toBe(false);
    expect(isAdjustableBucket({ fabricColorId: null, isActive: true, qty: 3 }, true)).toBe(true);
    // A negative bucket (rollback hazard, plan §3) stays reachable so it can be repaired.
    expect(isAdjustableBucket({ fabricColorId: null, isActive: true, qty: -2 }, true)).toBe(true);
    expect(isAdjustableBucket({ fabricColorId: null, isActive: true, qty: 0 }, false)).toBe(true);
  });
});

describe("per-colour reads", () => {
  test("listFabricColorBalancesByFabric: one call for many fabrics, buckets never leak between fabrics", async () => {
    await withRollback(async (tx) => {
      const a = await insertFabric(tx);
      const b = await insertFabric(tx);
      const empty = await insertFabric(tx);
      const sageA = await insertFabricColor(tx, a.id, { name: "Sage" });
      const sageB = await insertFabricColor(tx, b.id, { name: "Sage" });
      await stockIn(tx, a.id, sageA.id, 4, 78_000);
      await stockIn(tx, b.id, sageB.id, 9, 180_000);
      await recordFabricPurchase({ fabricId: b.id, qty: 3, totalAmountPaid: 60_000, purchasedAt: "2026-10-01" }, null, tx);

      const byFabric = await listFabricColorBalancesByFabric([a.id, b.id, empty.id], tx);
      expect(byFabric.get(a.id)).toEqual([
        { fabricColorId: sageA.id, name: "Sage", hex: null, isActive: true, hasMovements: true, qty: 4, valueAmount: 78_000 },
      ]);
      expect(byFabric.get(b.id)?.map((row) => [row.name, row.qty])).toEqual([
        ["Sage", 9],
        [null, 3],
      ]);
      expect(byFabric.get(empty.id)).toEqual([]);
      expect(await listFabricColorBalancesByFabric([], tx)).toEqual(new Map());
    });
  });

  test("listFabricStockLedger: colour per row, and filtered to one bucket its running balance is that bucket's", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage", hex: "#9CAF88" });
      const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
      // Explicit created_at: inside one transaction now() is frozen, so the ledger's order would
      // fall back to the random-uuid tiebreak (see fabric-stock.test.ts's ledger test).
      const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 8, minute));
      const row = (fabricColorId: string | null, qty: number, valueAmount: number, minute: number) =>
        qty > 0
          ? { fabricId: fabric.id, fabricColorId, qty, valueAmount, type: "purchase" as const, refType: "manual" as const, purchasedAt: "2026-11-01", createdAt: at(minute) }
          : { fabricId: fabric.id, fabricColorId, qty, valueAmount, type: "adjustment" as const, refType: "manual" as const, reason: "damaged" as const, createdAt: at(minute) };
      await tx.insert(fabricStockMovements).values([
        row(null, 30, 540_000, 1),
        row(sage.id, 10, 195_000, 2),
        row(mocca.id, 8, 240_000, 3),
        row(sage.id, -1, -19_500, 4),
      ]);

      const all = await listFabricStockLedger(fabric.id, undefined, undefined, tx);
      expect(all.rows).toHaveLength(4);
      expect(all.rows[0]).toMatchObject({ colorName: "Sage", colorHex: "#9CAF88", colorIsActive: true, qty: -1, runningQty: 47 });
      expect(all.rows.at(-1)).toMatchObject({ fabricColorId: null, colorName: null, runningQty: 30 });

      const sageOnly = await listFabricStockLedger(fabric.id, undefined, undefined, tx, { color: sage.id });
      expect(sageOnly.pagination.totalCount).toBe(2);
      expect(sageOnly.rows.map((row) => [row.qty, row.runningQty, row.runningValueAmount])).toEqual([
        [-1, 9, 175_500],
        [10, 10, 195_000],
      ]);

      const colourless = await listFabricStockLedger(fabric.id, undefined, undefined, tx, { color: null });
      expect(colourless.rows.map((row) => row.qty)).toEqual([30]);
    });
  });

  test("parseFabricColorFilter: 'tanpa' is Tanpa warna, a uuid is a colour, anything else is no filter", () => {
    const id = randomUUID();
    expect(parseFabricColorFilter("tanpa")).toBeNull();
    expect(parseFabricColorFilter(id)).toBe(id);
    expect(parseFabricColorFilter(id.toUpperCase())).toBe(id);
    expect(parseFabricColorFilter(undefined)).toBeUndefined();
    expect(parseFabricColorFilter("sage")).toBeUndefined();
  });
});
