import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabricStockMovements, fabrics, productionBatchFabricUsages, productionBatches, productionBatchItems } from "@ammari/db/schema";
import { getFabricBalance, getFabricColorBalance, recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { ActionError, FieldError } from "@/lib/errors";
import { createDraft, getBatchCosts, getBatchDetail, getBatchFabricConsumption, postBatch, updateDraft } from "./queries";

// docs/plans/fabric-colour-stock.md S5 (D6, owner decisions A1 and A4): a batch takes its fabric
// per colour bucket, each bucket checked against and valued at its own balance and average.

/** Coloured stock the way a goods receipt writes it (lib/receipts/colour.test.ts covers the
 * receipt path itself). */
async function stockIn(tx: TestDatabase, fabricId: string, fabricColorId: string, qty: number, valueAmount: number) {
  await tx.insert(fabricStockMovements).values({ fabricId, fabricColorId, qty, valueAmount, type: "purchase", refType: "manual", purchasedAt: "2026-11-01" });
}

/** "Tanpa warna" stock: a legacy colourless purchase, like everything bought before S2. */
async function colourlessStockIn(tx: TestDatabase, fabricId: string, qty: number, totalAmountPaid: number) {
  await recordFabricPurchase({ fabricId, qty, totalAmountPaid, purchasedAt: "2026-10-01" }, null, tx);
}

/** A fabric with Sage and Mocca, one SKU of each (size M). */
async function twoColourFixture(tx: TestDatabase) {
  const { fabric, color: sage, variant: sageVariant } = await insertProductVariant(tx);
  await tx.update(fabricColors).set({ name: "Sage" }).where(eq(fabricColors.id, sage.id));
  const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca" });
  const { variant: moccaVariant } = await insertVariantForProduct(tx, fabric.id, mocca.id);
  const staff = await insertStaffUser(tx);
  return { fabric, sage: { ...sage, name: "Sage" }, mocca, sageVariant, moccaVariant, staff };
}

async function usageRows(tx: TestDatabase, batchId: string) {
  const rows = await tx
    .select({ fabricColorId: productionBatchFabricUsages.fabricColorId, yards: productionBatchFabricUsages.yards })
    .from(productionBatchFabricUsages)
    .where(eq(productionBatchFabricUsages.productionBatchId, batchId));
  return rows.sort((a, b) => String(a.fabricColorId).localeCompare(String(b.fabricColorId)));
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("draft fabric usages per colour", () => {
  test("createDraft stores one row per source bucket and sets fabric_yards to their sum", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, mocca, sageVariant, moccaVariant, staff } = await twoColourFixture(tx);
      const batch = await createDraft(
        {
          fabricId: fabric.id,
          producedAt: "2026-11-21",
          fabricYards: 99, // ignored: the rows decide
          lines: [
            { sku: sageVariant.sku, qty: 6 },
            { sku: moccaVariant.sku, qty: 4 },
          ],
          fabricUsages: [
            { fabricColorId: sage.id, yards: 12.5 },
            { fabricColorId: mocca.id, yards: 8.25 },
          ],
        },
        staff.id,
        tx,
      );
      expect(batch.fabricYards).toBe(20.75);
      expect(await usageRows(tx, batch.id)).toEqual(
        [
          { fabricColorId: sage.id, yards: 12.5 },
          { fabricColorId: mocca.id, yards: 8.25 },
        ].sort((a, b) => a.fabricColorId.localeCompare(b.fabricColorId)),
      );

      const detail = await getBatchDetail(batch.id, tx);
      expect(detail?.fabricUsages.map((row) => [row.colorName, row.yards])).toEqual([
        ["Mocca", 8.25],
        ["Sage", 12.5],
      ]);

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, batch.id), eq(auditLog.action, "create")));
      expect((entry?.after as { fabricUsages: unknown[] }).fabricUsages).toEqual([
        { fabricColorId: sage.id, colorName: "Sage", yards: 12.5 },
        { fabricColorId: mocca.id, colorName: "Mocca", yards: 8.25 },
      ]);
    });
  });

  test("without usage rows the typed total is kept (a draft saved before any SKU is picked)", async () => {
    await withRollback(async (tx) => {
      const { fabric } = await twoColourFixture(tx);
      const batch = await createDraft({ fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: 15, lines: [] }, null, tx);
      expect(batch.fabricYards).toBe(15);
      expect(await usageRows(tx, batch.id)).toEqual([]);
    });
  });

  test("updateDraft replaces the set, Tanpa warna included", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, mocca, sageVariant } = await twoColourFixture(tx);
      const lines = [{ sku: sageVariant.sku, qty: 2 }];
      const batch = await createDraft(
        { fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: null, lines, fabricUsages: [{ fabricColorId: sage.id, yards: 4 }] },
        null,
        tx,
      );
      const after = await updateDraft(
        batch.id,
        {
          producedAt: "2026-11-21",
          fabricYards: null,
          lines,
          fabricUsages: [
            { fabricColorId: null, yards: 3 },
            { fabricColorId: mocca.id, yards: 1.5 },
          ],
        },
        null,
        tx,
      );
      expect(after.fabricYards).toBe(4.5);
      const rows = await usageRows(tx, batch.id);
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fabricColorId: null, yards: 3 });
      expect(rows).toContainEqual({ fabricColorId: mocca.id, yards: 1.5 });
    });
  });

  test("refuses a duplicate source, a colour of another fabric, and yards that are not > 0 with 2 decimals", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage } = await twoColourFixture(tx);
      const { color: foreign } = await insertProductVariant(tx);
      const base = { fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: null, lines: [] };

      const duplicate = createDraft(
        {
          ...base,
          fabricUsages: [
            { fabricColorId: sage.id, yards: 1 },
            { fabricColorId: sage.id, yards: 2 },
          ],
        },
        null,
        tx,
      );
      await expect(duplicate).rejects.toThrow(FieldError);
      await expect(duplicate).rejects.toThrow("Warna Sage muncul dua kali di pemakaian kain.");

      await expect(createDraft({ ...base, fabricUsages: [{ fabricColorId: foreign.id, yards: 1 }] }, null, tx)).rejects.toThrow(
        "Warna ini bukan warna bahan batch ini.",
      );
      await expect(createDraft({ ...base, fabricUsages: [{ fabricColorId: sage.id, yards: 0 }] }, null, tx)).rejects.toThrow(
        "Yard pemakaian kain harus lebih dari 0.",
      );
      await expect(createDraft({ ...base, fabricUsages: [{ fabricColorId: sage.id, yards: 1.005 }] }, null, tx)).rejects.toThrow(
        "Yard pemakaian kain maksimal 2 desimal.",
      );
    });
  });

  test("rows that each fit but together overflow fabric_yards are refused with a message", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, mocca } = await twoColourFixture(tx);
      await expect(
        createDraft(
          {
            fabricId: fabric.id,
            producedAt: "2026-11-21",
            fabricYards: null,
            lines: [],
            fabricUsages: [
              { fabricColorId: sage.id, yards: 99_999_999 },
              { fabricColorId: mocca.id, yards: 1 },
            ],
          },
          null,
          tx,
        ),
      ).rejects.toThrow("Total yard pemakaian kain terlalu besar.");
    });
  });

  test("an inactive colour may still be a source (it can hold stock)", async () => {
    await withRollback(async (tx) => {
      const { fabric, mocca } = await twoColourFixture(tx);
      await tx.update(fabricColors).set({ isActive: false }).where(eq(fabricColors.id, mocca.id));
      const batch = await createDraft(
        { fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: null, lines: [], fabricUsages: [{ fabricColorId: mocca.id, yards: 2 }] },
        null,
        tx,
      );
      expect(await usageRows(tx, batch.id)).toEqual([{ fabricColorId: mocca.id, yards: 2 }]);
    });
  });
});

describe("postBatch per colour bucket", () => {
  test("writes one production movement per usage row at that bucket's own average; fabric cost = Σ; HPP formula unchanged", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, mocca, sageVariant, moccaVariant, staff } = await twoColourFixture(tx);
      await stockIn(tx, fabric.id, sage.id, 10, 195_000); // 19.500/yard
      await stockIn(tx, fabric.id, mocca.id, 7, 210_000); // 30.000/yard
      const batch = await createDraft(
        {
          fabricId: fabric.id,
          producedAt: "2026-11-21",
          fabricYards: null,
          lines: [
            { sku: sageVariant.sku, qty: 3 },
            { sku: moccaVariant.sku, qty: 2 },
          ],
          fabricUsages: [
            { fabricColorId: sage.id, yards: 4 },
            { fabricColorId: mocca.id, yards: 2.5 },
          ],
        },
        null,
        tx,
      );

      const result = await postBatch(batch.id, staff.id, tx);

      const movements = await tx
        .select()
        .from(fabricStockMovements)
        .where(and(eq(fabricStockMovements.refType, "production_batch"), eq(fabricStockMovements.refId, batch.id)));
      expect(movements).toHaveLength(2);
      expect(movements.find((row) => row.fabricColorId === sage.id)).toMatchObject({ qty: -4, valueAmount: -78_000, type: "production" });
      expect(movements.find((row) => row.fabricColorId === mocca.id)).toMatchObject({ qty: -2.5, valueAmount: -75_000, type: "production" });

      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 6, valueAmount: 117_000 });
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 4.5, valueAmount: 135_000 });
      expect((await getBatchCosts(batch.id, tx))?.fabricCostAmount).toBe(153_000);
      // ceil(153.000 / 5 pcs), no accessories or extra costs.
      expect(result).toEqual({ id: batch.id, unitCostAmount: 30_600, totalPcs: 5 });

      expect(await getBatchFabricConsumption(batch.id, tx)).toEqual([
        { fabricColorId: mocca.id, colorName: "Mocca", colorHex: null, qty: 2.5, valueAmount: 75_000 },
        { fabricColorId: sage.id, colorName: "Sage", colorHex: null, qty: 4, valueAmount: 78_000 },
      ]);

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, batch.id), eq(auditLog.action, "post")));
      expect((entry?.after as { fabricConsumption: unknown[] }).fabricConsumption).toEqual(
        expect.arrayContaining([
          { fabricColorId: sage.id, colorName: "Sage", yards: 4, valueAmount: 78_000 },
          { fabricColorId: mocca.id, colorName: "Mocca", yards: 2.5, valueAmount: 75_000 },
        ]),
      );
    });
  });

  test("lists EVERY short colour in one message and writes nothing, even when the fabric total would cover it", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, mocca, sageVariant, staff } = await twoColourFixture(tx);
      await colourlessStockIn(tx, fabric.id, 100, 1_000_000); // plenty in Tanpa warna
      await stockIn(tx, fabric.id, sage.id, 6.8, 132_600);
      await stockIn(tx, fabric.id, mocca.id, 1, 30_000);
      const batch = await createDraft(
        {
          fabricId: fabric.id,
          producedAt: "2026-11-21",
          fabricYards: null,
          lines: [{ sku: sageVariant.sku, qty: 2 }],
          fabricUsages: [
            { fabricColorId: sage.id, yards: 10 },
            { fabricColorId: mocca.id, yards: 2 },
          ],
        },
        null,
        tx,
      );

      const message = await messageOf(postBatch(batch.id, staff.id, tx));
      expect(message).toBe("Stok kurang: Mocca kurang 1.00 yard, Sage kurang 3.20 yard.");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 107.8, valueAmount: 1_162_600 });
      const [stored] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batch.id));
      expect(stored?.status).toBe("draft");
    });
  });

  test("Tanpa warna is a bucket too: usable as a source, and never taken below zero", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, sageVariant, staff } = await twoColourFixture(tx);
      await colourlessStockIn(tx, fabric.id, 13.45, 269_000); // 20.000/yard
      await stockIn(tx, fabric.id, sage.id, 50, 1_000_000);
      const lines = [{ sku: sageVariant.sku, qty: 2 }];

      const tooMuch = await createDraft(
        { fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: null, lines, fabricUsages: [{ fabricColorId: null, yards: 14 }] },
        null,
        tx,
      );
      await expect(postBatch(tooMuch.id, staff.id, tx)).rejects.toThrow("Stok kurang: Tanpa warna kurang 0.55 yard.");

      // The whole bucket: the zero-residual rule clears its value exactly.
      const batch = await createDraft(
        { fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: null, lines, fabricUsages: [{ fabricColorId: null, yards: 13.45 }] },
        null,
        tx,
      );
      await postBatch(batch.id, staff.id, tx);
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect((await getBatchCosts(batch.id, tx))?.fabricCostAmount).toBe(269_000);
      const [movement] = await tx.select().from(fabricStockMovements).where(eq(fabricStockMovements.refId, batch.id));
      expect(movement?.fabricColorId).toBeNull();
    });
  });

  test("a draft without usage rows (saved by the release before S5) is refused at posting", async () => {
    await withRollback(async (tx) => {
      const { fabric, sageVariant, staff } = await twoColourFixture(tx);
      await colourlessStockIn(tx, fabric.id, 10, 100_000);
      const batch = await createDraft({ fabricId: fabric.id, producedAt: "2026-11-21", fabricYards: 5, lines: [{ sku: sageVariant.sku, qty: 1 }] }, null, tx);
      const error = await postBatch(batch.id, staff.id, tx).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ActionError);
      expect((error as Error).message).toBe("Isi pemakaian kain per warna lalu simpan.");
    });
  });

  test("usage rows that no longer add up to the batch's yards (the old release changed only fabric_yards) are refused", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, sageVariant, staff } = await twoColourFixture(tx);
      await stockIn(tx, fabric.id, sage.id, 20, 200_000);
      const batch = await createDraft(
        {
          fabricId: fabric.id,
          producedAt: "2026-11-21",
          fabricYards: null,
          lines: [{ sku: sageVariant.sku, qty: 1 }],
          fabricUsages: [{ fabricColorId: sage.id, yards: 5 }],
        },
        null,
        tx,
      );
      await tx.update(productionBatches).set({ fabricYards: 6 }).where(eq(productionBatches.id, batch.id));
      await expect(postBatch(batch.id, staff.id, tx)).rejects.toThrow(
        "Pemakaian kain per warna (5.00 yard) tidak sama dengan jumlah yard batch (6.00 yard). Buka draf, periksa pemakaian kain, lalu simpan.",
      );
    });
  });

  test("posted usage rows stay readable and the batch's line HPP is frozen", async () => {
    await withRollback(async (tx) => {
      const { fabric, sage, sageVariant, staff } = await twoColourFixture(tx);
      await stockIn(tx, fabric.id, sage.id, 3, 10); // 3.33/yard: rounding residue
      const batch = await createDraft(
        {
          fabricId: fabric.id,
          producedAt: "2026-11-21",
          fabricYards: null,
          lines: [{ sku: sageVariant.sku, qty: 3 }],
          fabricUsages: [{ fabricColorId: sage.id, yards: 3 }],
        },
        null,
        tx,
      );
      await postBatch(batch.id, staff.id, tx);
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));
      expect(lines.map((line) => line.unitCostAmount)).toEqual([4]); // ceil(10 / 3)
      expect((await getBatchDetail(batch.id, tx))?.fabricUsages).toHaveLength(1);
      // fabrics row untouched: the lock is a plain FOR UPDATE.
      const [fabricRow] = await tx.select().from(fabrics).where(eq(fabrics.id, fabric.id));
      expect(fabricRow?.name).toBe(fabric.name);
    });
  });
});
