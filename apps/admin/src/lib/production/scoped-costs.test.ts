import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { auditLog, costComponents, productionBatchCosts, productionBatchItems, products, suppliers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { getBatchPaymentSummary } from "@/lib/supplier-payments/batch-payments";
import { getSupplierBalances } from "@/lib/supplier-payments/supplier-balance";
import { createDraft, getBatchDetail, getBatchExtraCosts, postBatch, updateDraft, type ExtraCostLineInput } from "./queries";

// "Berlaku untuk" on batch cost lines (migration 0047): a cost line scoped to one product of a
// multi-product batch. Real case: one batch of Haura and Cyra (same fabric), sewn by one tailor at
// Rp39.000/pcs for Haura and Rp37.000/pcs for Cyra, paid as one bill.

async function twoProductBatchFixture(tx: TestDatabase) {
  const tag = randomUUID().slice(0, 6);
  const { fabric, color, product: haura, variant: hauraVariant } = await insertProductVariant(tx);
  await tx.update(products).set({ name: "Haura" }).where(eq(products.id, haura.id));
  const { product: cyra, variant: cyraVariant } = await insertVariantForProduct(tx, fabric.id, color.id, { name: "Cyra" });
  const staff = await insertStaffUser(tx);
  const [tailor] = await tx.insert(suppliers).values({ name: `Konveksi Teh Popong ${randomUUID().slice(0, 6)}` }).returning();
  const [sewing] = await tx
    .insert(costComponents)
    .values({ name: `Ongkos jahit ${tag}`, unit: "pcs", costType: "variable", defaultSupplierId: tailor!.id })
    .returning();
  const [packing] = await tx.insert(costComponents).values({ name: `Packing ${tag}`, unit: "pcs", costType: "variable" }).returning();
  const [pattern] = await tx.insert(costComponents).values({ name: `Pola ${tag}`, unit: "set", costType: "fixed" }).returning();
  // 18 yards at 100.000/yard: fabric cost 1.800.000 for an 18-pcs batch (100.000/pcs).
  await recordFabricPurchase({ fabricId: fabric.id, qty: 18, totalAmountPaid: 1_800_000, purchasedAt: "2026-11-01" }, null, tx);
  return {
    fabric,
    haura: { ...haura, name: "Haura" },
    cyra,
    hauraVariant,
    cyraVariant,
    staff,
    tailor: tailor!,
    sewing: sewing!,
    packing: packing!,
    pattern: pattern!,
  };
}

type Fixture = Awaited<ReturnType<typeof twoProductBatchFixture>>;

function draftInput(f: Fixture, extraCosts: ExtraCostLineInput[], qty = { haura: 10, cyra: 8 }) {
  const lines = [
    ...(qty.haura > 0 ? [{ sku: f.hauraVariant.sku, qty: qty.haura }] : []),
    ...(qty.cyra > 0 ? [{ sku: f.cyraVariant.sku, qty: qty.cyra }] : []),
  ];
  return {
    fabricId: f.fabric.id,
    producedAt: "2026-11-20",
    fabricYards: 18,
    fabricUsages: [{ fabricColorId: null, yards: 18 }],
    lines,
    extraCosts,
  };
}

async function unitCostBySku(tx: TestDatabase, batchId: string): Promise<Map<string, number>> {
  const rows = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batchId));
  return new Map(rows.map((row) => [row.sku, row.unitCostAmount]));
}

describe("cost lines scoped to one product", () => {
  test("Haura 10 pcs @39k + Cyra 8 pcs @37k + shared fabric: HPP per SKU and one supplier bill", async () => {
    await withRollback(async (tx) => {
      const f = await twoProductBatchFixture(tx);
      const batch = await createDraft(
        draftInput(f, [
          { costComponentId: f.sewing.id, unitPrice: 39_000, productId: f.haura.id },
          { costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id },
        ]),
        null,
        tx,
      );

      const saved = await getBatchExtraCosts(batch.id, tx);
      expect(saved.map((line) => ({ productName: line.productName, quantity: line.quantity, total: line.total, supplierId: line.supplierId }))).toEqual(
        expect.arrayContaining([
          { productName: "Haura", quantity: 10, total: 390_000, supplierId: f.tailor.id },
          { productName: "Cyra", quantity: 8, total: 296_000, supplierId: f.tailor.id },
        ]),
      );

      const result = await postBatch(batch.id, f.staff.id, tx);
      // Haura: 1.800.000 / 18 + 39.000 = 139.000; Cyra: 100.000 + 37.000 = 137.000.
      const bySku = await unitCostBySku(tx, batch.id);
      expect(bySku.get(f.hauraVariant.sku)).toBe(139_000);
      expect(bySku.get(f.cyraVariant.sku)).toBe(137_000);
      expect(result.unitCosts).toEqual(
        expect.arrayContaining([
          { productId: f.haura.id, pcs: 10, unitCostAmount: 139_000 },
          { productId: f.cyra.id, pcs: 8, unitCostAmount: 137_000 },
        ]),
      );
      // The batch average still covers every rupiah: (1.800.000 + 686.000) / 18, rounded up.
      expect(result.unitCostAmount).toBe(Math.ceil(2_486_000 / 18));

      // Supplier bill: still per batch per supplier, scoped lines included.
      const payment = await getBatchPaymentSummary(batch.id, tx);
      expect(payment?.overall.tagihan).toBe(686_000);
      expect(payment?.payees).toEqual([expect.objectContaining({ supplierId: f.tailor.id, tagihan: 686_000 })]);
      const balances = await getSupplierBalances([f.tailor.id], tx);
      expect(balances.get(f.tailor.id)).toEqual({ outstanding: 686_000, overpaid: 0, openDocuments: 1 });

      // The posted batch's lines carry product ids for the per-product breakdown.
      const detail = await getBatchDetail(batch.id, tx);
      expect(new Set(detail!.lines.map((line) => line.productId))).toEqual(new Set([f.haura.id, f.cyra.id]));

      // The post's audit entry records the HPP per product and each line's scope.
      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, batch.id), eq(auditLog.action, "post")))
        .orderBy(desc(auditLog.createdAt));
      const after = entry!.after as { unitCosts: unknown[]; extraCosts: { productName: string; total: number }[] };
      expect(after.unitCosts).toHaveLength(2);
      expect(after.extraCosts.map((line) => [line.productName, line.total]).sort()).toEqual([
        ["Cyra", 296_000],
        ["Haura", 390_000],
      ]);
    });
  });

  test("mixed scoped and batch-wide lines, including a fixed scoped line", async () => {
    await withRollback(async (tx) => {
      const f = await twoProductBatchFixture(tx);
      const batch = await createDraft(
        draftInput(f, [
          { costComponentId: f.sewing.id, unitPrice: 39_000, productId: f.haura.id },
          { costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id },
          { costComponentId: f.packing.id, unitPrice: 2_000 }, // every pcs: 36.000
          { costComponentId: f.pattern.id, unitPrice: 80_000, productId: f.cyra.id }, // Cyra only: 10.000/pcs
        ]),
        null,
        tx,
      );
      const saved = await getBatchExtraCosts(batch.id, tx);
      expect(saved.find((line) => line.costComponentId === f.packing.id)).toMatchObject({ productId: null, quantity: 18, total: 36_000 });
      expect(saved.find((line) => line.costComponentId === f.pattern.id)).toMatchObject({ productId: f.cyra.id, quantity: 1, total: 80_000 });

      await postBatch(batch.id, f.staff.id, tx);
      // shared = 1.800.000 + 36.000 = 1.836.000; / 18 = 102.000.
      const bySku = await unitCostBySku(tx, batch.id);
      expect(bySku.get(f.hauraVariant.sku)).toBe(102_000 + 39_000);
      expect(bySku.get(f.cyraVariant.sku)).toBe(102_000 + 37_000 + 10_000);
    });
  });

  test("without scoped lines every SKU gets the batch-wide HPP, as before", async () => {
    await withRollback(async (tx) => {
      const f = await twoProductBatchFixture(tx);
      const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 38_000 }]), null, tx);
      const result = await postBatch(batch.id, f.staff.id, tx);
      const bySku = await unitCostBySku(tx, batch.id);
      expect(bySku.get(f.hauraVariant.sku)).toBe(138_000);
      expect(bySku.get(f.cyraVariant.sku)).toBe(138_000);
      expect(result.unitCostAmount).toBe(138_000);
    });
  });

  test("a variable scoped line follows its product's pcs when the lines change", async () => {
    await withRollback(async (tx) => {
      const f = await twoProductBatchFixture(tx);
      const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id }]), null, tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);
      await updateDraft(
        batch.id,
        { ...draftInput(f, [{ id: line!.id, costComponentId: f.sewing.id, unitPrice: 37_000 }], { haura: 10, cyra: 5 }) },
        null,
        tx,
      );
      expect((await getBatchExtraCosts(batch.id, tx))[0]).toMatchObject({ productId: f.cyra.id, quantity: 5, total: 185_000 });
    });
  });

  test("scope can be changed on an existing line, and the update's audit entry records it", async () => {
    await withRollback(async (tx) => {
      const f = await twoProductBatchFixture(tx);
      const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 39_000 }]), null, tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line).toMatchObject({ productId: null, quantity: 18 });

      await updateDraft(batch.id, draftInput(f, [{ id: line!.id, costComponentId: f.sewing.id, unitPrice: 39_000, productId: f.haura.id }]), null, tx);
      expect((await getBatchExtraCosts(batch.id, tx))[0]).toMatchObject({ productId: f.haura.id, productName: "Haura", quantity: 10 });

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, batch.id), eq(auditLog.action, "update")))
        .orderBy(desc(auditLog.createdAt));
      expect((entry!.before as { extraCosts: { productName: string }[] }).extraCosts[0]!.productName).toBe("Semua produk");
      expect((entry!.after as { extraCosts: { productName: string; quantity: number }[] }).extraCosts[0]).toMatchObject({
        productName: "Haura",
        quantity: 10,
      });

      // Back to "Semua produk".
      await updateDraft(batch.id, draftInput(f, [{ id: line!.id, costComponentId: f.sewing.id, unitPrice: 39_000, productId: null }]), null, tx);
      expect((await getBatchExtraCosts(batch.id, tx))[0]).toMatchObject({ productId: null, quantity: 18 });
    });
  });

  describe("validation", () => {
    test("a scoped line's product must have SKUs in the batch", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        const error = await createDraft(
          draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id }], { haura: 10, cyra: 0 }),
          null,
          tx,
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FieldError);
        expect((error as Error).message).toBe(
          `Biaya "${f.sewing.name}" berlaku untuk Cyra, tetapi Cyra tidak punya SKU di batch ini. Ubah "Berlaku untuk" atau hapus biaya itu dulu.`,
        );
      });
    });

    test("an unknown product id is rejected", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        await expect(
          createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 1, productId: randomUUID() }]), null, tx),
        ).rejects.toThrow(/tidak ditemukan/);
      });
    });

    test("removing a product's SKUs while its scoped line stays is rejected; removing both is fine", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        const batch = await createDraft(
          draftInput(f, [
            { costComponentId: f.sewing.id, unitPrice: 39_000, productId: f.haura.id },
            { costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id },
          ]),
          null,
          tx,
        );
        const saved = await getBatchExtraCosts(batch.id, tx);
        const hauraLine = saved.find((line) => line.productId === f.haura.id)!;
        const cyraLine = saved.find((line) => line.productId === f.cyra.id)!;

        // The submitted line keeps its saved scope (productId omitted).
        await expect(
          updateDraft(
            batch.id,
            draftInput(
              f,
              [
                { id: hauraLine.id, costComponentId: f.sewing.id, unitPrice: 39_000 },
                { id: cyraLine.id, costComponentId: f.sewing.id, unitPrice: 37_000 },
              ],
              { haura: 10, cyra: 0 },
            ),
            null,
            tx,
          ),
        ).rejects.toThrow(`Biaya "${f.sewing.name}" berlaku untuk Cyra, tetapi Cyra tidak punya SKU di batch ini.`);

        await updateDraft(
          batch.id,
          draftInput(f, [{ id: hauraLine.id, costComponentId: f.sewing.id, unitPrice: 39_000 }], { haura: 10, cyra: 0 }),
          null,
          tx,
        );
        expect(await getBatchExtraCosts(batch.id, tx)).toHaveLength(1);
      });
    });

    test("a save that doesn't touch costs (no finance.view_profit) can't orphan a scoped line either", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id }]), null, tx);
        const withoutCosts = { ...draftInput(f, [], { haura: 10, cyra: 0 }), extraCosts: undefined };
        await expect(updateDraft(batch.id, withoutCosts, null, tx)).rejects.toThrow(/berlaku untuk Cyra/);
        // Still fine when the product stays.
        const keepsCyra = { ...draftInput(f, [], { haura: 10, cyra: 3 }), extraCosts: undefined };
        await updateDraft(batch.id, keepsCyra, null, tx);
      });
    });

    test("posting rejects a scoped line whose product has no SKUs left (e.g. after an older release's save)", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id }]), null, tx);
        await tx
          .delete(productionBatchItems)
          .where(and(eq(productionBatchItems.productionBatchId, batch.id), eq(productionBatchItems.sku, f.cyraVariant.sku)));
        const error = await postBatch(batch.id, f.staff.id, tx).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ActionError);
        expect((error as Error).message).toMatch(/berlaku untuk Cyra/);
      });
    });

    test("posted scoped lines are immutable", async () => {
      await withRollback(async (tx) => {
        const f = await twoProductBatchFixture(tx);
        const batch = await createDraft(draftInput(f, [{ costComponentId: f.sewing.id, unitPrice: 37_000, productId: f.cyra.id }]), null, tx);
        await postBatch(batch.id, f.staff.id, tx);
        await expect(
          tx.update(productionBatchCosts).set({ productId: null }).where(eq(productionBatchCosts.productionBatchId, batch.id)),
        ).rejects.toThrow();
      });
    });
  });
});
