import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { costComponents, productionBatchCosts, suppliers } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { listActiveSupplierOptions } from "@/lib/suppliers/queries";
import { createCostComponent, getCostComponentById, listCostComponents, updateCostComponent } from "./cost-components";
import { createDraft, getBatchExtraCosts, postBatch, updateDraft, type ExtraCostLineInput } from "./queries";

// Plan docs/plans/suppliers-goods-receipt.md, session S2 (D9): a default supplier on the cost
// component master, and a per-line supplier on production_batch_costs that defaults from it, can
// be overridden, is snapshotted, and is frozen once the batch posts.

async function insertSupplier(tx: TestDatabase, overrides: Partial<typeof suppliers.$inferInsert> = {}) {
  const [supplier] = await tx
    .insert(suppliers)
    .values({ name: `Penjahit Test ${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertComponent(tx: TestDatabase, overrides: Partial<typeof costComponents.$inferInsert> = {}) {
  const [component] = await tx
    .insert(costComponents)
    .values({ name: `Komponen Test ${randomUUID().slice(0, 8)}`, unit: "set", costType: "fixed", ...overrides })
    .returning();
  if (!component) throw new Error("failed to insert cost component fixture");
  return component;
}

async function draftWithCosts(tx: TestDatabase, extraCosts: ExtraCostLineInput[]) {
  const { fabric, variant } = await insertProductVariant(tx);
  const batch = await createDraft(
    { fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 2, lines: [{ sku: variant.sku, qty: 2 }], extraCosts },
    null,
    tx,
  );
  return { batch, fabric, variant };
}

function resave(batchId: string, sku: string, extraCosts: ExtraCostLineInput[], tx: TestDatabase) {
  return updateDraft(batchId, { producedAt: "2026-10-02", fabricYards: 2, lines: [{ sku, qty: 2 }], extraCosts }, null, tx);
}

/** drizzle wraps the driver error; the trigger's own RAISE text is on `.cause`. */
async function causeMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return String(cause);
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("batch cost line supplier: defaulting and override", () => {
  test("a new line that names no supplier takes the component's default, with the name snapshotted", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBe(supplier.id);
      expect(line?.supplierName).toBe(supplier.name);
      expect(line?.supplierIsActive).toBe(true);
    });
  });

  test("a per-line supplier beats the component's default", async () => {
    await withRollback(async (tx) => {
      const defaultSupplier = await insertSupplier(tx);
      const override = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: defaultSupplier.id });
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: override.id }]);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBe(override.id);
      expect(line?.supplierName).toBe(override.name);
    });
  });

  test("an explicit null means no supplier, even when the component has a default", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: null }]);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBeNull();
      expect(line?.supplierName).toBeNull();
    });
  });

  test("a component without a default leaves a new line without a supplier", async () => {
    await withRollback(async (tx) => {
      const component = await insertComponent(tx);
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBeNull();
      expect(line?.supplierName).toBeNull();
    });
  });

  test("an existing line's supplier can be changed and cleared while the batch is a draft", async () => {
    await withRollback(async (tx) => {
      const first = await insertSupplier(tx);
      const second = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: first.id });
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000, supplierId: second.id }], tx);
      const [changed] = await getBatchExtraCosts(batch.id, tx);
      expect(changed?.supplierId).toBe(second.id);
      expect(changed?.supplierName).toBe(second.name);

      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000, supplierId: null }], tx);
      const [cleared] = await getBatchExtraCosts(batch.id, tx);
      expect(cleared?.supplierId).toBeNull();
      expect(cleared?.supplierName).toBeNull();
    });
  });

  test("an existing line that omits supplierId keeps the supplier it has", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx);
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: supplier.id }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 2500 }], tx);
      const [after] = await getBatchExtraCosts(batch.id, tx);
      expect(after?.unitPrice).toBe(2500);
      expect(after?.supplierId).toBe(supplier.id);
    });
  });

  test("changing the component's default later never rewrites a line already added", async () => {
    await withRollback(async (tx) => {
      const original = await insertSupplier(tx);
      const later = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: original.id });
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await updateCostComponent(
        component.id,
        { name: component.name, unit: component.unit, defaultUnitPrice: null, costType: component.costType, isActive: true, sortOrder: 0, defaultSupplierId: later.id },
        null,
        tx,
      );
      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000 }], tx);

      const [after] = await getBatchExtraCosts(batch.id, tx);
      expect(after?.supplierId).toBe(original.id);
    });
  });
});

describe("batch cost line supplier: mixed saves", () => {
  test("a new line added on a later draft save also takes the component's default", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      const { batch, variant } = await draftWithCosts(tx, []);

      await resave(batch.id, variant.sku, [{ costComponentId: component.id, unitPrice: 1000 }], tx);
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBe(supplier.id);
      expect(line?.supplierName).toBe(supplier.name);
    });
  });

  test("an existing line without a supplier gets one, with its name snapshotted", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx);
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBeNull();

      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000, supplierId: supplier.id }], tx);
      const [after] = await getBatchExtraCosts(batch.id, tx);
      expect(after?.supplierId).toBe(supplier.id);
      expect(after?.supplierName).toBe(supplier.name);
    });
  });

  test("several lines in one save: shared default, an override and an existing line's change all apply", async () => {
    await withRollback(async (tx) => {
      const tailor = await insertSupplier(tx);
      const finisher = await insertSupplier(tx);
      const sewing = await insertComponent(tx, { defaultSupplierId: tailor.id });
      const finishing = await insertComponent(tx, { defaultSupplierId: tailor.id });
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: sewing.id, unitPrice: 1000 }]);
      const [existing] = await getBatchExtraCosts(batch.id, tx);

      await resave(
        batch.id,
        variant.sku,
        [
          { id: existing!.id, costComponentId: sewing.id, unitPrice: 1000, supplierId: finisher.id },
          { costComponentId: sewing.id, unitPrice: 2000 },
          { costComponentId: finishing.id, unitPrice: 3000 },
          { costComponentId: finishing.id, unitPrice: 4000, supplierId: finisher.id },
        ],
        tx,
      );
      const lines = await getBatchExtraCosts(batch.id, tx);
      const byPrice = new Map(lines.map((line) => [line.unitPrice, line.supplierId]));
      expect(byPrice).toEqual(
        new Map([
          [1000, finisher.id],
          [2000, tailor.id],
          [3000, tailor.id],
          [4000, finisher.id],
        ]),
      );
    });
  });

  test("one inactive choice among valid ones rejects the whole save, leaving nothing changed", async () => {
    await withRollback(async (tx) => {
      const active = await insertSupplier(tx);
      const inactive = await insertSupplier(tx, { isActive: false });
      const component = await insertComponent(tx);
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: active.id }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await expect(
        resave(
          batch.id,
          variant.sku,
          [
            { id: line!.id, costComponentId: component.id, unitPrice: 9999, supplierId: active.id },
            { costComponentId: component.id, unitPrice: 1000, supplierId: inactive.id },
          ],
          tx,
        ),
      ).rejects.toThrow(/dinonaktifkan/);
    });
  });
});

describe("batch cost line supplier: inactive suppliers", () => {
  test("an inactive supplier cannot be chosen for a NEW line", async () => {
    await withRollback(async (tx) => {
      const inactive = await insertSupplier(tx, { isActive: false });
      const component = await insertComponent(tx);
      const promise = draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: inactive.id }]);
      await expect(promise).rejects.toThrow(FieldError);
    });
  });

  test("an inactive supplier cannot be newly chosen on an EXISTING line either", async () => {
    await withRollback(async (tx) => {
      const inactive = await insertSupplier(tx, { isActive: false });
      const component = await insertComponent(tx);
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await expect(
        resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000, supplierId: inactive.id }], tx),
      ).rejects.toThrow(/dinonaktifkan/);
    });
  });

  test("a supplier deactivated after being set keeps working on the existing line", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx);
      const { batch, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: supplier.id }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await tx.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, supplier.id));

      // Re-submitting the SAME (now inactive) supplier is not a new selection: it saves.
      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 3000, supplierId: supplier.id }], tx);
      const [after] = await getBatchExtraCosts(batch.id, tx);
      expect(after?.unitPrice).toBe(3000);
      expect(after?.supplierId).toBe(supplier.id);
      expect(after?.supplierName).toBe(supplier.name);
      expect(after?.supplierIsActive).toBe(false);
    });
  });

  test("a deactivated component default is not applied to a new line, and does not block the save", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx, { isActive: false });
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);

      const [line] = await getBatchExtraCosts(batch.id, tx);
      expect(line?.supplierId).toBeNull();
    });
  });

  test("a supplier id that doesn't exist is rejected on the supplier field", async () => {
    await withRollback(async (tx) => {
      const component = await insertComponent(tx);
      await expect(
        draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: randomUUID() }]),
      ).rejects.toMatchObject({ field: "supplierId" });
    });
  });

  test("the picker lists active suppliers only, the preferred kind first", async () => {
    await withRollback(async (tx) => {
      const tag = randomUUID().slice(0, 8);
      const fabricShop = await insertSupplier(tx, { name: `A Toko ${tag}`, kinds: ["fabric"] });
      const tailor = await insertSupplier(tx, { name: `Z Penjahit ${tag}`, kinds: ["service"] });
      const inactive = await insertSupplier(tx, { name: `B Nonaktif ${tag}`, kinds: ["service"], isActive: false });

      const options = (await listActiveSupplierOptions("service", tx)).filter((option) => option.name.endsWith(tag));
      expect(options.map((option) => option.id)).toEqual([tailor.id, fabricShop.id]);
      expect(options.some((option) => option.id === inactive.id)).toBe(false);

      const unsorted = (await listActiveSupplierOptions(undefined, tx)).filter((option) => option.name.endsWith(tag));
      expect(unsorted.map((option) => option.id)).toEqual([fabricShop.id, tailor.id]);
    });
  });
});

describe("batch cost line supplier: snapshot and freeze", () => {
  test("the name snapshot survives a supplier rename across a later draft save and posting", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      const { batch, fabric, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);

      await tx.update(suppliers).set({ name: `Nama Baru ${randomUUID().slice(0, 8)}` }).where(eq(suppliers.id, supplier.id));
      // Same supplier re-submitted: not re-snapshotted.
      await resave(batch.id, variant.sku, [{ id: line!.id, costComponentId: component.id, unitPrice: 1000, supplierId: supplier.id }], tx);

      await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 50_000, purchasedAt: "2026-09-01" }, null, tx);
      await postBatch(batch.id, staff.id, tx);

      const [posted] = await getBatchExtraCosts(batch.id, tx);
      expect(posted?.supplierId).toBe(supplier.id);
      expect(posted?.supplierName).toBe(supplier.name); // the ORIGINAL name, not "Nama Baru ..."
    });
  });

  // Each rejection below gets its own withRollback: a failed statement aborts the transaction.
  async function postedBatchWithSupplier(tx: TestDatabase) {
    const staff = await insertStaffUser(tx);
    const supplier = await insertSupplier(tx);
    const other = await insertSupplier(tx);
    const component = await insertComponent(tx);
    const { batch, fabric, variant } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000, supplierId: supplier.id }]);
    await recordFabricPurchase({ fabricId: fabric.id, qty: 5, totalAmountPaid: 50_000, purchasedAt: "2026-09-01" }, null, tx);
    await postBatch(batch.id, staff.id, tx);
    const [line] = await getBatchExtraCosts(batch.id, tx);
    return { batch, variant, component, line: line!, other };
  }

  test("a posted batch's cost lines can't be re-saved through the app", async () => {
    await withRollback(async (tx) => {
      const { batch, variant, component, line, other } = await postedBatchWithSupplier(tx);
      await expect(
        resave(batch.id, variant.sku, [{ id: line.id, costComponentId: component.id, unitPrice: 1000, supplierId: other.id }], tx),
      ).rejects.toThrow(/sudah diposting/);
    });
  });

  test("the DB trigger rejects changing a posted line's supplier directly", async () => {
    await withRollback(async (tx) => {
      const { line, other } = await postedBatchWithSupplier(tx);
      const message = await causeMessageOf(
        tx.update(productionBatchCosts).set({ supplierId: other.id, supplierName: other.name }).where(eq(productionBatchCosts.id, line.id)),
      );
      expect(message).toMatch(/cannot modify cost lines of a posted production batch/);
    });
  });

  test("the DB trigger rejects rewriting a posted line's supplier name snapshot directly", async () => {
    await withRollback(async (tx) => {
      const { line } = await postedBatchWithSupplier(tx);
      const message = await causeMessageOf(
        tx.update(productionBatchCosts).set({ supplierName: "Ditulis ulang" }).where(eq(productionBatchCosts.id, line.id)),
      );
      expect(message).toMatch(/cannot modify cost lines of a posted production batch/);
    });
  });

  test("supplier_id and supplier_name are both-or-neither at the DB level", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx);
      const { batch } = await draftWithCosts(tx, [{ costComponentId: component.id, unitPrice: 1000 }]);
      const [line] = await getBatchExtraCosts(batch.id, tx);
      const message = await causeMessageOf(
        tx.update(productionBatchCosts).set({ supplierId: supplier.id }).where(eq(productionBatchCosts.id, line!.id)),
      );
      expect(message).toMatch(/production_batch_costs_supplier_pair_check/);
    });
  });
});

describe("cost component default supplier", () => {
  const base = { unit: "set" as const, defaultUnitPrice: null, costType: "fixed" as const, isActive: true, sortOrder: 0 };

  test("create with a default supplier, read back with its current name", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const created = await createCostComponent({ ...base, name: `Ongkos Test ${randomUUID().slice(0, 8)}`, defaultSupplierId: supplier.id }, null, tx);

      const fetched = await getCostComponentById(created.id, tx);
      expect(fetched?.defaultSupplierId).toBe(supplier.id);
      expect(fetched?.defaultSupplierName).toBe(supplier.name);
      expect(fetched?.defaultSupplierIsActive).toBe(true);

      const listed = (await listCostComponents(tx)).find((row) => row.id === created.id);
      expect(listed?.defaultSupplierName).toBe(supplier.name);
    });
  });

  test("an inactive supplier can't be chosen as a new default", async () => {
    await withRollback(async (tx) => {
      const inactive = await insertSupplier(tx, { isActive: false });
      await expect(
        createCostComponent({ ...base, name: `Ongkos Test ${randomUUID().slice(0, 8)}`, defaultSupplierId: inactive.id }, null, tx),
      ).rejects.toMatchObject({ field: "defaultSupplierId" });
    });
  });

  test("an inactive supplier can't be switched TO on update", async () => {
    await withRollback(async (tx) => {
      const inactive = await insertSupplier(tx, { isActive: false });
      const component = await insertComponent(tx);
      await expect(
        updateCostComponent(component.id, { ...base, name: component.name, defaultSupplierId: inactive.id }, null, tx),
      ).rejects.toThrow(/dinonaktifkan/);
    });
  });

  test("a default deactivated after being set survives an unrelated edit, and can be cleared", async () => {
    await withRollback(async (tx) => {
      const supplier = await insertSupplier(tx);
      const component = await insertComponent(tx, { defaultSupplierId: supplier.id });
      await tx.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, supplier.id));

      const kept = await updateCostComponent(component.id, { ...base, name: component.name, defaultUnitPrice: 5000, defaultSupplierId: supplier.id }, null, tx);
      expect(kept?.defaultSupplierId).toBe(supplier.id);
      expect(kept?.defaultUnitPrice).toBe(5000);
      expect((await getCostComponentById(component.id, tx))?.defaultSupplierIsActive).toBe(false);

      const untouched = await updateCostComponent(component.id, { ...base, name: component.name }, null, tx);
      expect(untouched?.defaultSupplierId).toBe(supplier.id);

      const cleared = await updateCostComponent(component.id, { ...base, name: component.name, defaultSupplierId: null }, null, tx);
      expect(cleared?.defaultSupplierId).toBeNull();
    });
  });
});
