import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import {
  costComponents,
  fabricColors,
  fabricStockMovements,
  fabrics,
  productAccessoryRecipes,
  productionBatches,
  productionBatchCosts,
  productionBatchItems,
  products,
  productVariants,
  stockMovements,
} from "@ammari/db/schema";
import { recordAccessoryPurchase, getAccessoryBalance } from "@/lib/inventory/accessories";
import { recordFabricPurchase, getFabricBalance } from "@/lib/inventory/fabric-stock";
import { saveAccessoryOverride } from "./accessory-needs";
import { generateBatchNumber } from "./batch-number";
import {
  createDraft,
  deleteDraft,
  getBatchAccessoryConsumption,
  getBatchCosts,
  getBatchDetail,
  getBatchExtraCosts,
  listBatches,
  postBatch,
  updateDraft,
} from "./queries";

async function insertBatchFixture(tx: TestDatabase, fabricId: string, overrides: Partial<Parameters<typeof createDraft>[0]> = {}) {
  return createDraft({ fabricId, producedAt: "2026-10-01", fabricYards: 10, lines: [], ...overrides }, null, tx);
}

async function insertCostComponentFixture(tx: TestDatabase, overrides: Partial<typeof costComponents.$inferInsert> = {}) {
  const [component] = await tx
    .insert(costComponents)
    .values({ name: `Komponen Test ${randomUUID().slice(0, 8)}`, unit: "pcs", ...overrides })
    .returning();
  if (!component) throw new Error("failed to insert cost component fixture");
  return component;
}

async function purchaseFabricStock(tx: TestDatabase, fabricId: string, qty: number, totalAmountPaid: number) {
  return recordFabricPurchase({ fabricId, qty, totalAmountPaid, purchasedAt: "2026-09-01" }, null, tx);
}

async function purchaseAccessoryStock(tx: TestDatabase, accessoryId: string, qty: number, totalAmountPaid: number) {
  return recordAccessoryPurchase({ accessoryId, qty, totalAmountPaid, purchasedAt: "2026-09-01" }, null, tx);
}

/** Only for real-commit (non-withRollback) fixture cleanup, where a test deliberately posts a
 * batch via a genuine race (so it can't just roll back) and then needs to remove it afterward —
 * prevent_posted_batch_delete (migration 0007) otherwise rejects deleting ANY posted batch,
 * which is correct production behavior but not what disposable test fixtures need. */
async function forceDeletePostedBatchFixture(db: TestDatabase, batchId: string): Promise<void> {
  await withTriggerDisabled(db, "production_batches", "prevent_posted_batch_delete", () =>
    db.delete(productionBatches).where(eq(productionBatches.id, batchId)),
  );
}

/** Same reasoning as forceDeletePostedBatchFixture — stock_movements is now append-only
 * (migration 0008, prevent_stock_movement_mutation), so a real-commit test's own disposable
 * movement rows need the trigger-disabling helper instead of a plain delete. */
async function forceDeleteStockMovementsFixture(db: TestDatabase, sku: string): Promise<void> {
  await withTriggerDisabled(db, "stock_movements", "prevent_stock_movement_mutation", () =>
    db.delete(stockMovements).where(eq(stockMovements.sku, sku)),
  );
}

/** Same reasoning, for fabric_stock_movements (purchase + production-consumption rows a
 * real-commit test creates against a disposable fabric). */
async function forceDeleteFabricStockMovementsFixture(db: TestDatabase, fabricId: string): Promise<void> {
  await withTriggerDisabled(db, "fabric_stock_movements", "prevent_fabric_stock_movement_mutation", () =>
    db.delete(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabricId)),
  );
}

/** drizzle-orm wraps the driver error as "Failed query: ..." and puts the real Postgres message
 * (our RAISE EXCEPTION text) on `.cause` — same unwrapping packages/db/test/product-variants.test.ts
 * uses for its own trigger tests. */
async function causeMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return String(cause);
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("generateBatchNumber", () => {
  test("two drafts created in the same month get -001 and -002", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const first = await insertBatchFixture(tx, fabric.id);
      const second = await insertBatchFixture(tx, fabric.id);
      expect(first.batchNo.endsWith("-001")).toBe(true);
      expect(second.batchNo.endsWith("-002")).toBe(true);
      // Same prefix (same month) on both.
      expect(second.batchNo.slice(0, -4)).toBe(first.batchNo.slice(0, -4));
    });
  });

  test("a batch created at 2026-10-31T17:30:00Z (= 00:30 WIB on 1 Nov) gets PRD-202611-001", async () => {
    await withRollback(async (tx) => {
      const batchNo = await generateBatchNumber(tx, new Date("2026-10-31T17:30:00Z"));
      expect(batchNo).toBe("PRD-202611-001");
    });
  });

  test("concurrent creation (5 at once) yields 5 distinct sequential numbers, no errors", async () => {
    // Real commits, not withRollback's single shared transaction — genuine advisory-lock
    // contention needs separate connections/transactions (same reasoning as
    // lib/products/image-queries.test.ts's concurrent-delete test), so cleanup here is manual.
    const { fabric, color, product, variant } = await insertProductVariant(testDb);
    let createdIds: string[] = [];
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => insertBatchFixture(testDb, fabric.id)));
      createdIds = results.map((batch) => batch.id);
      const batchNos = results.map((batch) => batch.batchNo).sort();
      expect(new Set(batchNos).size).toBe(5); // all distinct
      const sequences = batchNos.map((batchNo) => Number.parseInt(batchNo.split("-")[2]!, 10));
      expect(sequences.sort((a, b) => a - b)).toEqual(Array.from({ length: 5 }, (_, i) => Math.min(...sequences) + i));
    } finally {
      await testDb.delete(productionBatches).where(inArray(productionBatches.id, createdIds));
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("postBatch", () => {
  test("computes fabric cost from the fabric's current moving-average cost, consuming exactly the yards used", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 1_000_000); // avg 100_000/yard, exactly enough for a 10-yard batch
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 3 }] });

      const result = await postBatch(batch.id, staff.id, tx);
      expect(result.totalPcs).toBe(3);
      expect(result.unitCostAmount).toBe(Math.ceil(1_000_000 / 3)); // 333334, rounds UP

      const items = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));
      expect(items).toHaveLength(1);
      expect(items[0]!.unitCostAmount).toBe(333_334);

      const costs = await getBatchCosts(batch.id, tx);
      expect(costs?.fabricCostAmount).toBe(1_000_000);

      // Consumed exactly the stock purchased — correction #1's zero-residual rule leaves no
      // stranded value behind at zero stock.
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 0, valueAmount: 0 });

      // The finished-goods stock_movements row carries its own cost basis too (qty *
      // unit_cost_amount) — this is what a later sale's moving-average HPP is computed from.
      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1);
      expect(movements[0]!.valueAmount).toBe(3 * 333_334);
    });
  });

  test("HPP folds in both a variable (per-pcs) and a fixed (per-batch) cost line", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const variableComponent = await insertCostComponentFixture(tx, { costType: "variable" });
      const fixedComponent = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 2 }],
        extraCosts: [
          { costComponentId: variableComponent.id, unitPrice: 10 },
          { costComponentId: fixedComponent.id, unitPrice: 500 },
        ],
      });

      // The variable line's quantity was already auto-set to totalPcs (2) on save; the fixed
      // line's quantity is always exactly 1 — neither was submitted by this test.
      const savedLines = await getBatchExtraCosts(batch.id, tx);
      expect(savedLines.find((l) => l.costComponentId === variableComponent.id)).toMatchObject({ quantity: 2, total: 20 });
      expect(savedLines.find((l) => l.costComponentId === fixedComponent.id)).toMatchObject({ quantity: 1, total: 500 });

      const result = await postBatch(batch.id, staff.id, tx);
      // totalCost = 100_000 (fabric) + 20 (variable) + 500 (fixed) = 100_520; / 2 pcs = 50_260.
      expect(result.unitCostAmount).toBe(50_260);
    });
  });

  test("re-verifies a variable line's quantity at posting, never trusting a value that reached the row some other way", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const component = await insertCostComponentFixture(tx, { costType: "variable" });
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 5 }],
        extraCosts: [{ costComponentId: component.id, unitPrice: 10 }],
      });
      const [line] = await getBatchExtraCosts(batch.id, tx);
      // Simulate a stale/tampered quantity — postBatch must overwrite this with the batch's
      // REAL total pcs (5) right before computing totals, not trust whatever is already there.
      await tx.update(productionBatchCosts).set({ quantity: 999 }).where(eq(productionBatchCosts.id, line!.id));

      const result = await postBatch(batch.id, staff.id, tx);
      // totalCost = 100_000 + (5 * 10) = 100_050; / 5 pcs = 20_010.
      expect(result.unitCostAmount).toBe(20_010);
    });
  });

  test("resolves a direct accessory recipe row, consumes exactly what's needed, and folds its cost into HPP", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const accessory = await insertAccessory(tx, { name: "Hang tag" });
      await purchaseAccessoryStock(tx, accessory.id, 100, 50_000); // avg 500/pcs
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 2 });

      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 3 }] }); // needs 6 pcs

      const result = await postBatch(batch.id, staff.id, tx);
      // totalCost = 100_000 (fabric) + 6 * 500 (accessory) = 103_000; / 3 pcs = 34_334 (ceil).
      expect(result.unitCostAmount).toBe(Math.ceil(103_000 / 3));

      expect((await getAccessoryBalance(accessory.id, tx)).qty).toBe(100 - 6);

      const consumption = await getBatchAccessoryConsumption(batch.id, tx);
      expect(consumption).toEqual([
        { accessoryId: accessory.id, accessoryName: accessory.name, qty: 6, valueAmount: 3_000, overridden: false },
      ]);
    });
  });

  test("an all-size variant resolves a sizeGroup recipe row to the group's ALLSIZE item", async () => {
    await withRollback(async (tx) => {
      const { fabric, color } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const { product, variant } = await insertVariantForProduct(tx, fabric.id, color.id, { sizeMode: "all_size" }, "ALLSIZE");
      const label = await insertAccessory(tx, { name: "Label Polos", sizeGroup: "Label", size: "ALLSIZE" });
      await purchaseAccessoryStock(tx, label.id, 10, 1_000);
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Label", qtyPerPcs: 1 });

      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 4 }] });
      await postBatch(batch.id, staff.id, tx);

      expect((await getAccessoryBalance(label.id, tx)).qty).toBe(6);
    });
  });

  test("rejects posting when a sizeGroup recipe row can't be resolved, naming the product/size/group", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx); // size M
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Grup Hilang", qtyPerPcs: 1 });
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });

      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/Grup Hilang/);
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 10, valueAmount: 100_000 }); // nothing consumed
    });
  });

  test("rejects posting on insufficient fabric stock, naming the fabric", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 5, 50_000); // only 5 yards, batch needs 10
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });

      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(new RegExp(fabric.name));
    });
  });

  test("rejects posting on insufficient accessory stock, listing it alongside a fabric shortage — message content", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 1, 10_000); // batch needs 10 yards — short
      const accessory = await insertAccessory(tx, { name: "Kancing Kurang" });
      await purchaseAccessoryStock(tx, accessory.id, 1, 500); // batch needs 5 — short
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 1 });
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 5 }] });

      let caught: unknown;
      try {
        await postBatch(batch.id, staff.id, tx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = String((caught as Error).message);
      expect(message).toMatch(new RegExp(fabric.name));
      expect(message).toMatch(/Kancing Kurang/);

      // Nothing was consumed — the whole post was rejected before any movement was written.
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 1, valueAmount: 10_000 });
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 1, valueAmount: 500 });
    });
  });

  test("an accessory override replaces the computed need for effective consumption and shortage checking", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const accessory = await insertAccessory(tx, { name: "Kancing Override" });
      await purchaseAccessoryStock(tx, accessory.id, 2, 1_000); // only 2 in stock
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 1 });
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 5 }] }); // computed need: 5, would be short

      await saveAccessoryOverride(batch.id, accessory.id, 2, staff.id, tx); // override down to exactly what's in stock
      await expect(postBatch(batch.id, staff.id, tx)).resolves.not.toThrow();
      expect((await getAccessoryBalance(accessory.id, tx)).qty).toBe(0);

      // Flagged as overridden on the posted breakdown (security-review finding: an override can
      // change a posted batch's recorded cost, so a finance viewer needs to be able to see which
      // lines were overridden).
      const [consumption] = await getBatchAccessoryConsumption(batch.id, tx);
      expect(consumption?.overridden).toBe(true);
    });
  });

  test("refuses to post with no lines", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/minimal satu baris/);
    });
  });

  test("refuses to post with no fabric yards filled in", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { fabricYards: null, lines: [{ sku: variant.sku, qty: 1 }] });
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/yard/);
    });
  });

  test("posting twice concurrently posts exactly once", async () => {
    const { fabric, variant, color, product } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    await purchaseFabricStock(testDb, fabric.id, 10, 500_000);
    const batch = await insertBatchFixture(testDb, fabric.id, { lines: [{ sku: variant.sku, qty: 2 }] });

    try {
      const outcomes = await Promise.allSettled([postBatch(batch.id, staff.id, testDb), postBatch(batch.id, staff.id, testDb)]);
      const succeeded = outcomes.filter((o) => o.status === "fulfilled");
      const failed = outcomes.filter((o) => o.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const rows = await testDb.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(rows).toHaveLength(1); // exactly one movement, not two
    } finally {
      await forceDeleteStockMovementsFixture(testDb, variant.sku);
      await forceDeleteFabricStockMovementsFixture(testDb, fabric.id);
      // The winning postBatch call left this batch posted — prevent_posted_batch_delete
      // (migration 0007) now rejects a plain delete, so this disposable fixture needs the
      // trigger-disabling helper instead.
      await forceDeletePostedBatchFixture(testDb, batch.id);
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });

  test("a posted batch cannot be edited or deleted (app-level check)", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });
      await postBatch(batch.id, staff.id, tx);

      await expect(
        updateDraft(batch.id, { producedAt: "2026-10-02", fabricYards: 5, lines: [] }, staff.id, tx),
      ).rejects.toThrow(/sudah diposting/);
      await expect(deleteDraft(batch.id, staff.id, tx)).rejects.toThrow(/sudah diposting/);
    });
  });

  test("posting is rejected a second time on an already-posted batch (sequential)", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });
      await postBatch(batch.id, staff.id, tx);
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/sudah diposting/);
    });
  });

  test("concurrency: updateDraft adding a cost line racing postBatch never produces a posted batch whose HPP excludes a line that exists", async () => {
    // Real commits — genuine row-lock contention between two SEPARATE transactions, same
    // reasoning as the "posting twice concurrently" test above.
    const { fabric, variant, color, product } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    await purchaseFabricStock(testDb, fabric.id, 10, 100_000);
    const component = await insertCostComponentFixture(testDb, { costType: "fixed" });
    const batch = await insertBatchFixture(testDb, fabric.id, { lines: [{ sku: variant.sku, qty: 2 }] });

    try {
      const outcomes = await Promise.allSettled([
        updateDraft(
          batch.id,
          {
            producedAt: "2026-10-01",
            fabricYards: 10,
            lines: [{ sku: variant.sku, qty: 2 }],
            extraCosts: [{ costComponentId: component.id, unitPrice: 50_000 }],
          },
          staff.id,
          testDb,
        ),
        postBatch(batch.id, staff.id, testDb),
      ]);

      const updateOutcome = outcomes[0]!;
      const postOutcome = outcomes[1]!;

      const [finalBatch] = await testDb.select().from(productionBatches).where(eq(productionBatches.id, batch.id));
      expect(finalBatch?.status).toBe("posted");

      const extraCosts = await testDb.select().from(productionBatchCosts).where(eq(productionBatchCosts.productionBatchId, batch.id));

      if (updateOutcome.status === "fulfilled") {
        // The update won the race (ran first, fully committed) — postBatch (running second,
        // after the lock released) must see the committed extra-cost line and include it.
        expect(extraCosts).toHaveLength(1);
        if (postOutcome.status === "fulfilled") {
          expect(postOutcome.value.unitCostAmount).toBe(Math.ceil((100_000 + 50_000) / 2));
        }
      } else {
        // The update lost the race against an already-posted batch — rejected with the
        // "already posted" error, and the extra-cost line it tried to add was never persisted.
        expect(String(updateOutcome.reason)).toMatch(/sudah diposting/);
        expect(extraCosts).toHaveLength(0);
        expect(postOutcome.status).toBe("fulfilled");
      }
    } finally {
      // Delete the PARENT row first, not its children explicitly — the posted-batch triggers on
      // production_batch_items/production_batch_costs look up THIS row's status, and Postgres
      // marks it deleted (invisible to that lookup, within this same transaction) before the
      // ON DELETE CASCADE to its children fires. Deleting a child directly first would still see
      // the parent as 'posted' and get rejected by its own trigger. The parent row itself is now
      // ALSO guarded (prevent_posted_batch_delete), and stock_movements/fabric_stock_movements are
      // now append-only too — all three disposable fixtures need the trigger-disabling helper
      // rather than a plain delete.
      await forceDeleteStockMovementsFixture(testDb, variant.sku);
      await forceDeleteFabricStockMovementsFixture(testDb, fabric.id);
      await forceDeletePostedBatchFixture(testDb, batch.id);
      await testDb.delete(costComponents).where(eq(costComponents.id, component.id));
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("production_batch_costs.total (generated column, rounding correctness — DB level)", () => {
  // Reached only via a direct INSERT (not the app, which always computes an integer quantity —
  // totalPcs for a variable line, 1 for a fixed one) — kept to confirm the generated column
  // itself still matches Postgres's own round(), not JS float rounding, regardless of how a row
  // gets here.
  test("0.35 x 10 generates 4, matching Postgres round() — NOT 3 (the JS float-error answer)", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      const [row] = await tx
        .insert(productionBatchCosts)
        .values({
          productionBatchId: batch.id,
          costComponentId: component.id,
          componentName: component.name,
          componentUnit: component.unit,
          costType: component.costType,
          quantity: 0.35,
          unitPrice: 10,
        })
        .returning();
      expect(row?.total).toBe(4);
    });
  });

  test("a .x5 boundary rounds up (half away from zero), same as Postgres round()", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      const [row] = await tx
        .insert(productionBatchCosts)
        .values({
          productionBatchId: batch.id,
          costComponentId: component.id,
          componentName: component.name,
          componentUnit: component.unit,
          costType: component.costType,
          quantity: 1.5,
          unitPrice: 101,
        })
        .returning(); // 151.5 -> 152
      expect(row?.total).toBe(152);
    });
  });
});

describe("syncExtraCostLines", () => {
  test("a submitted line id that doesn't belong to this batch rejects the WHOLE save", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batchA = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }],
      });
      const [lineOnBatchA] = await getBatchExtraCosts(batchA.id, tx);
      const batchB = await insertBatchFixture(tx, fabric.id);

      // lineOnBatchA.id genuinely exists, but belongs to batchA, not batchB — must be rejected,
      // not silently ignored.
      await expect(
        updateDraft(
          batchB.id,
          {
            producedAt: "2026-10-01",
            fabricYards: 10,
            lines: [],
            extraCosts: [{ id: lineOnBatchA!.id, costComponentId: component.id, unitPrice: 2000 }],
          },
          staff.id,
          tx,
        ),
      ).rejects.toThrow(/tidak ditemukan/);

      // batchA's own line must be completely untouched by the rejected attempt.
      const [stillLineOnBatchA] = await getBatchExtraCosts(batchA.id, tx);
      expect(stillLineOnBatchA?.unitPrice).toBe(1000);
    });
  });

  test("a new line must reference an ACTIVE component", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { isActive: false, costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id);

      await expect(
        updateDraft(
          batch.id,
          { producedAt: "2026-10-01", fabricYards: 10, lines: [], extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }] },
          staff.id,
          tx,
        ),
      ).rejects.toThrow(/dinonaktifkan/);
    });
  });

  test("an EXISTING line keeps working after its component is deactivated", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, { extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }] });
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await tx.update(costComponents).set({ isActive: false }).where(eq(costComponents.id, component.id));

      // Updating the EXISTING line's price must succeed even though its component is now
      // inactive — only a brand NEW line requires an active component.
      await updateDraft(
        batch.id,
        { producedAt: "2026-10-01", fabricYards: 10, lines: [], extraCosts: [{ id: line!.id, costComponentId: component.id, unitPrice: 2000 }] },
        staff.id,
        tx,
      );

      const [updated] = await getBatchExtraCosts(batch.id, tx);
      expect(updated?.unitPrice).toBe(2000);
    });
  });

  test("a variable line can't be saved before the batch has any pcs", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const component = await insertCostComponentFixture(tx, { costType: "variable" });
      await expect(
        insertBatchFixture(tx, fabric.id, { lines: [], extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }] }),
      ).rejects.toThrow(/biaya variabel/);
    });
  });

  test("a variable line's quantity tracks the batch's total pcs across edits, without the client ever sending it", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { costType: "variable" });
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 3 }],
        extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }],
      });
      expect((await getBatchExtraCosts(batch.id, tx))[0]?.quantity).toBe(3);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      await updateDraft(
        batch.id,
        {
          producedAt: "2026-10-01",
          fabricYards: 10,
          lines: [{ sku: variant.sku, qty: 7 }],
          extraCosts: [{ id: line!.id, costComponentId: component.id, unitPrice: 1000 }],
        },
        staff.id,
        tx,
      );
      expect((await getBatchExtraCosts(batch.id, tx))[0]?.quantity).toBe(7);
    });
  });
});

describe("component name/unit/cost_type snapshot", () => {
  test("survives a component rename and a cost_type change across an unrelated draft edit", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const originalName = `Kancing Test ${randomUUID().slice(0, 8)}`;
      const component = await insertCostComponentFixture(tx, { name: originalName, costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, { extraCosts: [{ costComponentId: component.id, unitPrice: 500 }] });
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.componentName).toBe(originalName);
      expect(line?.costType).toBe("fixed");

      // Rename AND flip the cost_type of the component...
      await tx.update(costComponents).set({ name: "Kancing Jepret", costType: "variable" }).where(eq(costComponents.id, component.id));

      // ...then save an UNRELATED edit to the same draft (different producedAt), touching the
      // SAME existing cost line only via its id.
      await updateDraft(
        batch.id,
        { producedAt: "2026-10-03", fabricYards: 10, lines: [], extraCosts: [{ id: line!.id, costComponentId: component.id, unitPrice: 500 }] },
        staff.id,
        tx,
      );

      const [stillSnapshot] = await getBatchExtraCosts(batch.id, tx);
      expect(stillSnapshot?.componentName).toBe(originalName); // NOT "Kancing Jepret"
      expect(stillSnapshot?.costType).toBe("fixed"); // NOT "variable" — frozen, and still quantity=1
      expect(stillSnapshot?.quantity).toBe(1);
    });
  });
});

describe("immutability triggers (DB-level, direct SQL — not just app code)", () => {
  // Each assertion below gets its OWN withRollback transaction — a failed statement aborts the
  // rest of a Postgres transaction ("current transaction is aborted"), so a rejection assertion
  // and any statement after it (including another rejection assertion) can never share one `tx`.

  async function insertPostedBatchFixture(tx: TestDatabase) {
    const { fabric, variant } = await insertProductVariant(tx);
    const staff = await insertStaffUser(tx);
    await purchaseFabricStock(tx, fabric.id, 10, 100_000);
    const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });
    await postBatch(batch.id, staff.id, tx);
    return { fabric, variant, batch, staff };
  }

  test("production_batches: fabric_cost_amount is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricCostAmount: 999 }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: fabric_yards is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricYards: 99 }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: fabric_id is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const { fabric: otherFabric } = await insertProductVariant(tx);
      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricId: otherFabric.id }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: unrelated fields (notes) remain editable even when posted", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      await expect(
        tx.update(productionBatches).set({ notes: "catatan baru" }).where(eq(productionBatches.id, batch.id)),
      ).resolves.not.toThrow();
    });
  });

  test("production_batches: rejects a direct DELETE of a posted batch (not just the frozen fields)", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const message = await causeMessageOf(tx.delete(productionBatches).where(eq(productionBatches.id, batch.id)));
      expect(message).toMatch(/cannot delete a posted production batch/);
    });
  });

  test("production_batches: a DRAFT batch can still be deleted directly (the guard only fires once posted)", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      await expect(tx.delete(productionBatches).where(eq(productionBatches.id, batch.id))).resolves.not.toThrow();
    });
  });

  test("production_batch_items: rejects a direct UPDATE on a posted batch's line", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const [item] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));
      const message = await causeMessageOf(
        tx.update(productionBatchItems).set({ qty: 999 }).where(eq(productionBatchItems.id, item!.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batch_costs: rejects a direct INSERT on a posted batch", async () => {
    await withRollback(async (tx) => {
      const { batch } = await insertPostedBatchFixture(tx);
      const component = await insertCostComponentFixture(tx);
      const message = await causeMessageOf(
        tx.insert(productionBatchCosts).values({
          productionBatchId: batch.id,
          costComponentId: component.id,
          componentName: component.name,
          componentUnit: component.unit,
          costType: component.costType,
          quantity: 1,
          unitPrice: 1000,
        }),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batch_costs: rejects a direct UPDATE on a posted batch's line", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const component = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }],
      });
      await postBatch(batch.id, staff.id, tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      const message = await causeMessageOf(
        tx.update(productionBatchCosts).set({ unitPrice: 5000 }).where(eq(productionBatchCosts.id, line!.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batch_costs: rejects a direct DELETE on a posted batch's line", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await purchaseFabricStock(tx, fabric.id, 10, 100_000);
      const component = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        extraCosts: [{ costComponentId: component.id, unitPrice: 1000 }],
      });
      await postBatch(batch.id, staff.id, tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      const message = await causeMessageOf(tx.delete(productionBatchCosts).where(eq(productionBatchCosts.id, line!.id)));
      expect(message).toMatch(/posted production batch/);
    });
  });
});

describe("listBatches", () => {
  test("totalPcs is a real number (not a stringified bigint) summed across every line", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 7 }] });

      const { rows } = await listBatches(undefined, undefined, undefined, tx);
      const row = rows.find((r) => r.id === batch.id);
      expect(row?.totalPcs).toBe(7);
      expect(typeof row?.totalPcs).toBe("number");
    });
  });

  test("a batch with no fabric_yards (the legacy pre-feature batch) is returned with null, not a crash or 0", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { fabricYards: null });

      const { rows } = await listBatches(undefined, undefined, undefined, tx);
      const row = rows.find((r) => r.id === batch.id);
      expect(row?.fabricYards).toBeNull();

      const detail = await getBatchDetail(batch.id, tx);
      expect(detail?.fabricYards).toBeNull();
    });
  });
});

describe("cost visibility", () => {
  test("getBatchDetail's result never carries cost fields", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      const detail = await getBatchDetail(batch.id, tx);
      expect(detail).not.toHaveProperty("fabricCostAmount");
    });
  });

  test("getBatchCosts is the only way to read fabric_cost_amount, and a draft's is still 0 (computed only at posting)", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id);
      const costs = await getBatchCosts(batch.id, tx);
      expect(costs).toEqual({ fabricCostAmount: 0 });
    });
  });

  test("updateDraft without `extraCosts` leaves it completely untouched", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { costType: "fixed" });
      const batch = await insertBatchFixture(tx, fabric.id, { extraCosts: [{ costComponentId: component.id, unitPrice: 10_000 }] });

      // A production.manage-only edit — no `extraCosts` key at all.
      await updateDraft(batch.id, { producedAt: "2026-10-05", fabricYards: 12, lines: [] }, staff.id, tx);

      const extraCosts = await getBatchExtraCosts(batch.id, tx);
      expect(extraCosts).toHaveLength(1);
      expect(extraCosts[0]?.unitPrice).toBe(10_000);
    });
  });
});
