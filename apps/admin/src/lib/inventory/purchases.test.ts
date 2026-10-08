import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory } from "@ammari/db/test-fixtures";
import { accessories, accessoryMovements, fabrics, fabricStockMovements } from "@ammari/db/schema";
import { recordAccessoryAdjustment, recordAccessoryPurchase } from "./accessories";
import { recordFabricAdjustment, recordFabricPurchase } from "./fabric-stock";
import { getPurchaseById, listPurchases, stripPurchaseAmount, stripPurchaseAmounts } from "./purchases";

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx
    .insert(fabrics)
    .values({ name: `Katun Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

describe("getPurchaseById", () => {
  test("returns a fabric purchase", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      const movement = await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, tx);

      const purchase = await getPurchaseById(movement.id, tx);
      expect(purchase?.itemType).toBe("fabric");
      expect(purchase?.itemId).toBe(fabric.id);
      expect(purchase?.qty).toBe(10);
      expect(purchase?.totalAmountPaid).toBe(100_000);
    });
  });

  test("returns an accessory purchase", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      const movement = await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" },
        null,
        tx,
      );

      const purchase = await getPurchaseById(movement.id, tx);
      expect(purchase?.itemType).toBe("accessory");
      expect(purchase?.itemId).toBe(accessory.id);
    });
  });

  test("returns null for a non-purchase movement id (fabric adjustment) — never shows it as a purchase", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, tx);
      const adjustment = await recordFabricAdjustment({ fabricId: fabric.id, deltaQty: -1, reason: "damaged" }, null, tx);

      expect(await getPurchaseById(adjustment.id, tx)).toBeNull();
    });
  });

  test("returns null for a non-purchase movement id (accessory adjustment) — never shows it as a purchase", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" }, null, tx);
      const adjustment = await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -1, reason: "damaged" }, null, tx);

      expect(await getPurchaseById(adjustment.id, tx)).toBeNull();
    });
  });

  test("returns null for an id that doesn't exist at all", async () => {
    await withRollback(async (tx) => {
      expect(await getPurchaseById("00000000-0000-0000-0000-000000000000", tx)).toBeNull();
    });
  });
});

describe("listPurchases", () => {
  test("with no type filter, unions both fabric and accessory purchases", async () => {
    // Real commits, not withRollback — same reasoning as accessories.test.ts's ledger test:
    // the union's ORDER BY needs genuinely different created_at values, which a single shared
    // transaction (now() frozen at its start) can't produce.
    const fabric = await insertFabric(testDb);
    const accessory = await insertAccessory(testDb);
    try {
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, testDb);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" }, null, testDb);

      const { rows } = await listPurchases({}, undefined, undefined, testDb);
      expect(rows.some((row) => row.itemType === "fabric" && row.itemId === fabric.id)).toBe(true);
      expect(rows.some((row) => row.itemType === "accessory" && row.itemId === accessory.id)).toBe(true);
    } finally {
      // Both movement tables are append-only (migration 0008) — these disposable fixtures'
      // own rows need the trigger-disabling helper rather than a plain delete, same as
      // accessories.test.ts's ledger test.
      await withTriggerDisabled(testDb, "fabric_stock_movements", "prevent_fabric_stock_movement_mutation", () =>
        testDb.delete(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id)),
      );
      await withTriggerDisabled(testDb, "accessory_movements", "prevent_accessory_movement_mutation", () =>
        testDb.delete(accessoryMovements).where(eq(accessoryMovements.accessoryId, accessory.id)),
      );
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
      await testDb.delete(accessories).where(eq(accessories.id, accessory.id));
    }
  });

  test("type='fabric' only returns fabric purchases", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabric(tx);
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, tx);

      const { rows } = await listPurchases({ type: "fabric" }, undefined, undefined, tx);
      expect(rows.every((row) => row.itemType === "fabric")).toBe(true);
      expect(rows.some((row) => row.itemId === fabric.id)).toBe(true);
    });
  });

  test("type='accessory' only returns accessory purchases", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" }, null, tx);

      const { rows } = await listPurchases({ type: "accessory" }, undefined, undefined, tx);
      expect(rows.every((row) => row.itemType === "accessory")).toBe(true);
      expect(rows.some((row) => row.itemId === accessory.id)).toBe(true);
    });
  });
});

describe("stripPurchaseAmount(s)", () => {
  const row = {
    id: "m1",
    itemType: "fabric" as const,
    itemId: "f1",
    itemName: "Katun",
    qty: 10,
    totalAmountPaid: 100_000,
    purchasedAt: "2026-01-01",
    supplier: null,
    voidedAt: null,
    createdAt: new Date(),
  };

  test("keeps totalAmountPaid when canViewProfit is true", () => {
    expect(stripPurchaseAmount(row, true).totalAmountPaid).toBe(100_000);
    expect(stripPurchaseAmounts([row], true)[0]?.totalAmountPaid).toBe(100_000);
  });

  test("strips totalAmountPaid to null when canViewProfit is false", () => {
    expect(stripPurchaseAmount(row, false).totalAmountPaid).toBeNull();
    expect(stripPurchaseAmounts([row], false)[0]?.totalAmountPaid).toBeNull();
  });

  test("stripping does not mutate other fields", () => {
    const stripped = stripPurchaseAmount(row, false);
    expect(stripped.qty).toBe(10);
    expect(stripped.itemName).toBe("Katun");
  });
});
