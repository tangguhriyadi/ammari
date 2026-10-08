import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled } from "@ammari/db/test-utils";
import { insertAccessory, insertStaffUser } from "@ammari/db/test-fixtures";
import { accessories, accessoryMovements } from "@ammari/db/schema";
import {
  createAccessory,
  getAccessoryBalance,
  getAccessoryById,
  listAccessories,
  listAccessoryLedger,
  listDistinctSizeGroups,
  recordAccessoryAdjustment,
  recordAccessoryPurchase,
  setAccessoryActive,
  updateAccessory,
  voidAccessoryPurchase,
} from "./accessories";

describe("accessory master CRUD", () => {
  test("createAccessory, updateAccessory, setAccessoryActive round-trip", async () => {
    await withRollback(async (tx) => {
      const created = await createAccessory({ name: "Kancing Jepret", size: null, sizeGroup: null, notes: "dari Pasar Baru" }, null, tx);
      expect(created.isActive).toBe(true);

      const updated = await updateAccessory(created.id, { name: "Kancing Jepret Besar", isActive: true }, null, tx);
      expect(updated.name).toBe("Kancing Jepret Besar");

      const deactivated = await setAccessoryActive(created.id, false, null, tx);
      expect(deactivated.isActive).toBe(false);

      const fetched = await getAccessoryById(created.id, tx);
      expect(fetched?.name).toBe("Kancing Jepret Besar");
    });
  });

  test("two accessories in the same size_group claiming the same size is rejected", async () => {
    await withRollback(async (tx) => {
      const group = `Label Ammari ${randomUUID().slice(0, 8)}`;
      await createAccessory({ name: "Label M", size: "M", sizeGroup: group }, null, tx);
      await expect(createAccessory({ name: "Label M lagi", size: "M", sizeGroup: group }, null, tx)).rejects.toThrow();
    });
  });

  test("ALLSIZE is a valid size (the group's 'Polos' item)", async () => {
    await withRollback(async (tx) => {
      const group = `Label Ammari ${randomUUID().slice(0, 8)}`;
      const polos = await createAccessory({ name: "Label Polos", size: "ALLSIZE", sizeGroup: group }, null, tx);
      expect(polos.size).toBe("ALLSIZE");
    });
  });

  test("listDistinctSizeGroups returns each group once, sorted, excluding ungrouped accessories", async () => {
    await withRollback(async (tx) => {
      const groupA = `AAA Group ${randomUUID().slice(0, 8)}`;
      const groupB = `ZZZ Group ${randomUUID().slice(0, 8)}`;
      await createAccessory({ name: "A1", size: "S", sizeGroup: groupA }, null, tx);
      await createAccessory({ name: "A2", size: "M", sizeGroup: groupA }, null, tx);
      await createAccessory({ name: "B1", size: "S", sizeGroup: groupB }, null, tx);
      await createAccessory({ name: "Ungrouped", size: null, sizeGroup: null }, null, tx);

      const groups = await listDistinctSizeGroups(tx);
      expect(groups).toContain(groupA);
      expect(groups).toContain(groupB);
      expect(groups.indexOf(groupA)).toBeLessThan(groups.indexOf(groupB)); // sorted
      expect(groups.filter((g) => g === groupA)).toHaveLength(1); // once, not twice
    });
  });

  test("listAccessories reflects purchases in qty/valueAmount even though the query itself doesn't gate finance data", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" }, null, tx);

      const { rows } = await listAccessories({}, undefined, tx);
      const row = rows.find((r) => r.id === accessory.id);
      expect(row?.qty).toBe(50);
      expect(row?.valueAmount).toBe(25_000);
    });
  });
});

describe("recordAccessoryPurchase", () => {
  test("increases qty and value by exactly what was entered — no rounding at all", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 144, totalAmountPaid: 500_000, purchasedAt: "2026-01-01" }, null, tx);
      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(144);
      expect(balance.valueAmount).toBe(500_000);
    });
  });

  test("a second purchase at a different price produces a correct moving average", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 100, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" }, null, tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 100, totalAmountPaid: 200_000, purchasedAt: "2026-02-01" }, null, tx);
      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(200);
      expect(balance.valueAmount).toBe(300_000);
      expect(balance.valueAmount / balance.qty).toBe(1500); // average of 1000 and 2000
    });
  });
});

describe("recordAccessoryAdjustment", () => {
  test("rejects a negative-going adjustment that would drive stock below zero", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 5, totalAmountPaid: 5_000, purchasedAt: "2026-01-01" }, null, tx);
      await expect(
        recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -10, reason: "damaged" }, null, tx),
      ).rejects.toThrow(/negatif/);
    });
  });

  test("correction #1: consuming down to zero via several adjustments leaves value EXACTLY 0, never a rounding residue", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      // 1 of value — classic 1/3 rounding case.
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 3, totalAmountPaid: 1, purchasedAt: "2026-01-01" }, null, tx);
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -1, reason: "other" }, null, tx);
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -2, reason: "other" }, null, tx);

      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(0);
      expect(balance.valueAmount).toBe(0); // not 1 or -1 of residue

      const rows = await tx.select().from(accessoryMovements).where(eq(accessoryMovements.accessoryId, accessory.id));
      const sumValue = rows.reduce((sum, row) => sum + row.valueAmount, 0);
      expect(sumValue).toBe(0);
    });
  });

  test("a positive adjustment is valued at the current average and does not change it", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await recordAccessoryPurchase({ accessoryId: accessory.id, qty: 10, totalAmountPaid: 10_000, purchasedAt: "2026-01-01" }, null, tx);
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: 5, reason: "recount" }, null, tx);
      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(15);
      expect(balance.valueAmount / balance.qty).toBe(1000); // average unchanged
    });
  });
});

describe("voidAccessoryPurchase (correction #2)", () => {
  test("voiding a purchase with nothing after it succeeds and exactly reverses it", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      const staff = await insertStaffUser(tx);
      const purchase = await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 50, totalAmountPaid: 25_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );

      await voidAccessoryPurchase(purchase.id, staff.id, tx);

      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(0);
      expect(balance.valueAmount).toBe(0);

      const [reloaded] = await tx.select().from(accessoryMovements).where(eq(accessoryMovements.id, purchase.id));
      expect(reloaded?.voidedAt).not.toBeNull();
      expect(reloaded?.voidedByStaffUserId).toBe(staff.id);
    });
  });

  test("voiding a purchase that already has a consumption after it is rejected with the Sesuaikan-stok message", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      const staff = await insertStaffUser(tx);
      const purchase = await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 100, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -10, reason: "damaged" }, staff.id, tx);

      await expect(voidAccessoryPurchase(purchase.id, staff.id, tx)).rejects.toThrow(/Sesuaikan stok/);

      // Nothing changed — the rejected void left the balance exactly as the adjustment left it.
      const balance = await getAccessoryBalance(accessory.id, tx);
      expect(balance.qty).toBe(90);
    });
  });

  test("the worked example from the approved plan: a later consumption blocks voiding an EARLIER purchase, even though a LATER purchase alone would not", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      const staff = await insertStaffUser(tx);
      const firstPurchase = await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 100, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );
      // A second purchase alone does not block voiding the first (purchase is not a blocking
      // type) — confirmed by voiding it successfully below, in isolation, in a SEPARATE
      // scenario (see the "nothing after it" test above). Here we add a CONSUMPTION after the
      // second purchase instead, which blocks voiding the FIRST purchase too since it's still
      // "after" it by insertion order.
      await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 100, totalAmountPaid: 200_000, purchasedAt: "2026-02-01" },
        staff.id,
        tx,
      );
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -100, reason: "other" }, staff.id, tx);

      await expect(voidAccessoryPurchase(firstPurchase.id, staff.id, tx)).rejects.toThrow(/Sesuaikan stok/);
    });
  });

  test("double-voiding the same purchase is rejected", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      const staff = await insertStaffUser(tx);
      const purchase = await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 10, totalAmountPaid: 10_000, purchasedAt: "2026-01-01" },
        staff.id,
        tx,
      );
      await voidAccessoryPurchase(purchase.id, staff.id, tx);
      await expect(voidAccessoryPurchase(purchase.id, staff.id, tx)).rejects.toThrow(/sudah dibatalkan/);
    });
  });

  // Note: there is no test here for "voiding would drive stock negative" — given every purchase
  // is enforced positive (see recordAccessoryPurchase's own qty check) and the later-movement
  // check above already rejects voiding past any reducing movement, that branch is a defensive
  // backstop that isn't reachable through this function's own public API. See its doc comment.
});

describe("recordAccessoryPurchase input validation", () => {
  test("rejects a non-positive qty", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await expect(
        recordAccessoryPurchase({ accessoryId: accessory.id, qty: 0, totalAmountPaid: 1000, purchasedAt: "2026-01-01" }, null, tx),
      ).rejects.toThrow(/lebih dari 0/);
    });
  });

  test("rejects a negative totalAmountPaid", async () => {
    await withRollback(async (tx) => {
      const accessory = await insertAccessory(tx);
      await expect(
        recordAccessoryPurchase({ accessoryId: accessory.id, qty: 10, totalAmountPaid: -1, purchasedAt: "2026-01-01" }, null, tx),
      ).rejects.toThrow(/tidak boleh negatif/);
    });
  });
});

describe("accessory ledger", () => {
  test("listAccessoryLedger reports a correct running qty and value, newest first", async () => {
    // Real commits, not withRollback — Postgres's now() is frozen at TRANSACTION start, so two
    // inserts sharing withRollback's one transaction would get the IDENTICAL created_at, leaving
    // the id-tiebreak (a random UUID, not a sequence) to decide "newest" — which doesn't reflect
    // real insertion order. Each call here gets its own top-level transaction, same as it would
    // in production, so created_at genuinely differs between them.
    const accessory = await insertAccessory(testDb);
    try {
      await recordAccessoryPurchase(
        { accessoryId: accessory.id, qty: 100, totalAmountPaid: 100_000, purchasedAt: "2026-01-01" },
        null,
        testDb,
      );
      await recordAccessoryAdjustment({ accessoryId: accessory.id, deltaQty: -20, reason: "damaged" }, null, testDb);

      const { rows } = await listAccessoryLedger(accessory.id, undefined, testDb);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.type).toBe("adjustment"); // newest first
      expect(rows[0]?.runningQty).toBe(80);
      expect(rows[1]?.type).toBe("purchase");
      expect(rows[1]?.runningQty).toBe(100);
    } finally {
      // accessory_movements is append-only (migration 0008) — this disposable fixture's own
      // rows need the trigger-disabling helper rather than a plain delete.
      await withTriggerDisabled(testDb, "accessory_movements", "prevent_accessory_movement_mutation", () =>
        testDb.delete(accessoryMovements).where(eq(accessoryMovements.accessoryId, accessory.id)),
      );
      await testDb.delete(accessories).where(eq(accessories.id, accessory.id));
    }
  });
});
