import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import {
  costComponents,
  fabricColors,
  fabrics,
  productionBatches,
  productionBatchCosts,
  productionBatchItems,
  products,
  productVariants,
  stockMovements,
} from "@ammari/db/schema";
import { generateBatchNumber } from "./batch-number";
import {
  createDraft,
  deleteDraft,
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

/** Only for real-commit (non-withRollback) fixture cleanup, where a test deliberately posts a
 * batch via a genuine race (so it can't just roll back) and then needs to remove it afterward —
 * prevent_posted_batch_delete (migration 0007) otherwise rejects deleting ANY posted batch,
 * which is correct production behavior but not what disposable test fixtures need. */
async function forceDeletePostedBatchFixture(db: TestDatabase, batchId: string): Promise<void> {
  await db.execute(sql`ALTER TABLE production_batches DISABLE TRIGGER prevent_posted_batch_delete`);
  try {
    await db.delete(productionBatches).where(eq(productionBatches.id, batchId));
  } finally {
    await db.execute(sql`ALTER TABLE production_batches ENABLE TRIGGER prevent_posted_batch_delete`);
  }
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
  test("creates exactly one movement per line with the correct (ceil) unit cost, fabric cost only", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 3 }],
        costs: { fabricCostAmount: 1_000_000 },
      });

      const result = await postBatch(batch.id, staff.id, tx);
      expect(result.totalPcs).toBe(3);
      expect(result.unitCostAmount).toBe(Math.ceil(1_000_000 / 3)); // 333334, rounds UP

      const items = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));
      expect(items).toHaveLength(1);
      expect(items[0]!.unitCostAmount).toBe(333_334);
    });
  });

  test("HPP includes extra-cost lines (fabric cost + every extra line's generated total)", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 2 }],
        costs: { fabricCostAmount: 100_000 },
        extraCosts: [{ costComponentId: component.id, quantity: 0.35, unitPrice: 10 }], // total = 4 (see rounding test)
      });

      const result = await postBatch(batch.id, staff.id, tx);
      // totalCost = 100_000 + 4 = 100_004; / 2 pcs = 50_002.
      expect(result.unitCostAmount).toBe(50_002);
    });
  });

  test("refuses to post with no lines", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { costs: { fabricCostAmount: 100_000 } });
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/minimal satu baris/);
    });
  });

  test("refuses to post with no fabric cost filled in", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { lines: [{ sku: variant.sku, qty: 1 }] });
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/biaya bahan/);
    });
  });

  test("refuses to post with no fabric yards filled in", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        fabricYards: null,
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/yard/);
    });
  });

  test("posting twice concurrently posts exactly once", async () => {
    const { fabric, variant, color, product } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    const batch = await insertBatchFixture(testDb, fabric.id, {
      lines: [{ sku: variant.sku, qty: 2 }],
      costs: { fabricCostAmount: 500_000 },
    });

    try {
      const outcomes = await Promise.allSettled([postBatch(batch.id, staff.id, testDb), postBatch(batch.id, staff.id, testDb)]);
      const succeeded = outcomes.filter((o) => o.status === "fulfilled");
      const failed = outcomes.filter((o) => o.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const rows = await testDb.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(rows).toHaveLength(1); // exactly one movement, not two
    } finally {
      await testDb.delete(stockMovements).where(eq(stockMovements.sku, variant.sku));
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
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
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
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(/sudah diposting/);
    });
  });

  test("concurrency: updateDraft adding a cost line racing postBatch never produces a posted batch whose HPP excludes a line that exists", async () => {
    // Real commits — genuine row-lock contention between two SEPARATE transactions, same
    // reasoning as the "posting twice concurrently" test above.
    const { fabric, variant, color, product } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    const component = await insertCostComponentFixture(testDb);
    const batch = await insertBatchFixture(testDb, fabric.id, {
      lines: [{ sku: variant.sku, qty: 2 }],
      costs: { fabricCostAmount: 100_000 },
    });

    try {
      const outcomes = await Promise.allSettled([
        updateDraft(
          batch.id,
          {
            producedAt: "2026-10-01",
            fabricYards: 10,
            lines: [{ sku: variant.sku, qty: 2 }],
            costs: { fabricCostAmount: 100_000 },
            extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 50_000 }],
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
      // ALSO guarded (prevent_posted_batch_delete), so this disposable fixture needs the
      // trigger-disabling helper rather than a plain delete.
      await testDb.delete(stockMovements).where(eq(stockMovements.sku, variant.sku));
      await forceDeletePostedBatchFixture(testDb, batch.id);
      await testDb.delete(costComponents).where(eq(costComponents.id, component.id));
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("production_batch_costs.total (generated column, rounding correctness)", () => {
  test("0.35 x 10 generates 4, matching Postgres round() — NOT 3 (the JS float-error answer)", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        extraCosts: [{ costComponentId: component.id, quantity: 0.35, unitPrice: 10 }],
      });
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.total).toBe(4);
    });
  });

  test("a .x5 boundary rounds up (half away from zero), same as Postgres round()", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        extraCosts: [{ costComponentId: component.id, quantity: 1.5, unitPrice: 101 }], // 151.5 -> 152
      });
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.total).toBe(152);
    });
  });
});

describe("syncExtraCostLines security", () => {
  test("a submitted line id that doesn't belong to this batch rejects the WHOLE save", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx);
      const batchA = await insertBatchFixture(tx, fabric.id, {
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 1000 }],
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
            costs: { fabricCostAmount: 0 },
            extraCosts: [{ id: lineOnBatchA!.id, costComponentId: component.id, quantity: 2, unitPrice: 2000 }],
          },
          staff.id,
          tx,
        ),
      ).rejects.toThrow(/tidak ditemukan/);

      // batchA's own line must be completely untouched by the rejected attempt.
      const [stillLineOnBatchA] = await getBatchExtraCosts(batchA.id, tx);
      expect(stillLineOnBatchA?.quantity).toBe(1);
      expect(stillLineOnBatchA?.unitPrice).toBe(1000);
    });
  });

  test("a new line must reference an ACTIVE component", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx, { isActive: false });
      const batch = await insertBatchFixture(tx, fabric.id);

      await expect(
        updateDraft(
          batch.id,
          {
            producedAt: "2026-10-01",
            fabricYards: 10,
            lines: [],
            costs: { fabricCostAmount: 0 },
            extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 1000 }],
          },
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
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 1000 }],
      });
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await tx.update(costComponents).set({ isActive: false }).where(eq(costComponents.id, component.id));

      // Updating the EXISTING line's quantity must succeed even though its component is now
      // inactive — only a brand NEW line requires an active component.
      await updateDraft(
        batch.id,
        {
          producedAt: "2026-10-01",
          fabricYards: 10,
          lines: [],
          costs: { fabricCostAmount: 0 },
          extraCosts: [{ id: line!.id, costComponentId: component.id, quantity: 3, unitPrice: 1000 }],
        },
        staff.id,
        tx,
      );

      const [updated] = await getBatchExtraCosts(batch.id, tx);
      expect(updated?.quantity).toBe(3);
    });
  });
});

describe("component name/unit snapshot", () => {
  test("survives a component rename across an unrelated draft edit", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const originalName = `Kancing Test ${randomUUID().slice(0, 8)}`;
      const component = await insertCostComponentFixture(tx, { name: originalName });
      const batch = await insertBatchFixture(tx, fabric.id, {
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 500 }],
      });
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.componentName).toBe(originalName);

      // Rename the component...
      await tx.update(costComponents).set({ name: "Kancing Jepret" }).where(eq(costComponents.id, component.id));

      // ...then save an UNRELATED edit to the same draft (different producedAt), touching the
      // SAME existing cost line only via its id (quantity unchanged).
      await updateDraft(
        batch.id,
        {
          producedAt: "2026-10-03",
          fabricYards: 10,
          lines: [],
          costs: { fabricCostAmount: 0 },
          extraCosts: [{ id: line!.id, costComponentId: component.id, quantity: 1, unitPrice: 500 }],
        },
        staff.id,
        tx,
      );

      const [stillSnapshot] = await getBatchExtraCosts(batch.id, tx);
      expect(stillSnapshot?.componentName).toBe(originalName); // NOT "Kancing Jepret"
    });
  });
});

describe("immutability triggers (DB-level, direct SQL — not just app code)", () => {
  // Each assertion below gets its OWN withRollback transaction — a failed statement aborts the
  // rest of a Postgres transaction ("current transaction is aborted"), so a rejection assertion
  // and any statement after it (including another rejection assertion) can never share one `tx`.

  test("production_batches: fabric_cost_amount is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricCostAmount: 999 }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: fabric_yards is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricYards: 99 }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: fabric_id is frozen once posted", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const { fabric: otherFabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

      const message = await causeMessageOf(
        tx.update(productionBatches).set({ fabricId: otherFabric.id }).where(eq(productionBatches.id, batch.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batches: unrelated fields (notes) remain editable even when posted", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

      await expect(
        tx.update(productionBatches).set({ notes: "catatan baru" }).where(eq(productionBatches.id, batch.id)),
      ).resolves.not.toThrow();
    });
  });

  test("production_batches: the draft -> posted transition itself is never blocked by its own trigger", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await expect(postBatch(batch.id, staff.id, tx)).resolves.not.toThrow();
    });
  });

  test("production_batches: rejects a direct DELETE of a posted batch (not just the 3 frozen fields)", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

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
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);
      const [item] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));

      const message = await causeMessageOf(
        tx.update(productionBatchItems).set({ qty: 999 }).where(eq(productionBatchItems.id, item!.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batch_costs: rejects a direct INSERT on a posted batch", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
      });
      await postBatch(batch.id, staff.id, tx);

      const message = await causeMessageOf(
        tx.insert(productionBatchCosts).values({
          productionBatchId: batch.id,
          costComponentId: component.id,
          componentName: component.name,
          componentUnit: component.unit,
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
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 1000 }],
      });
      await postBatch(batch.id, staff.id, tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      const message = await causeMessageOf(
        tx.update(productionBatchCosts).set({ quantity: 5 }).where(eq(productionBatchCosts.id, line!.id)),
      );
      expect(message).toMatch(/posted production batch/);
    });
  });

  test("production_batch_costs: rejects a direct DELETE on a posted batch's line", async () => {
    await withRollback(async (tx) => {
      const { fabric, variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        lines: [{ sku: variant.sku, qty: 1 }],
        costs: { fabricCostAmount: 100_000 },
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 1000 }],
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

      const { rows } = await listBatches(undefined, undefined, tx);
      const row = rows.find((r) => r.id === batch.id);
      expect(row?.totalPcs).toBe(7);
      expect(typeof row?.totalPcs).toBe("number");
    });
  });

  test("a batch with no fabric_yards (the legacy pre-feature batch) is returned with null, not a crash or 0", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { fabricYards: null });

      const { rows } = await listBatches(undefined, undefined, tx);
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
      const batch = await insertBatchFixture(tx, fabric.id, { costs: { fabricCostAmount: 1 } });
      const detail = await getBatchDetail(batch.id, tx);
      expect(detail).not.toHaveProperty("fabricCostAmount");
    });
  });

  test("getBatchCosts is the only way to read fabric_cost_amount", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabric.id, { costs: { fabricCostAmount: 111 } });
      const costs = await getBatchCosts(batch.id, tx);
      expect(costs).toEqual({ fabricCostAmount: 111 });
    });
  });

  test("updateDraft without `costs`/`extraCosts` leaves both completely untouched", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const component = await insertCostComponentFixture(tx);
      const batch = await insertBatchFixture(tx, fabric.id, {
        costs: { fabricCostAmount: 500_000 },
        extraCosts: [{ costComponentId: component.id, quantity: 1, unitPrice: 10_000 }],
      });

      // A production.manage-only edit — no `costs`/`extraCosts` keys at all.
      await updateDraft(batch.id, { producedAt: "2026-10-05", fabricYards: 12, lines: [] }, staff.id, tx);

      const costs = await getBatchCosts(batch.id, tx);
      expect(costs).toEqual({ fabricCostAmount: 500_000 });
      const extraCosts = await getBatchExtraCosts(batch.id, tx);
      expect(extraCosts).toHaveLength(1);
      expect(extraCosts[0]?.unitPrice).toBe(10_000);
    });
  });
});
