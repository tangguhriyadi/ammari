import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { productAccessoryRecipes } from "@ammari/db/schema";
import { getAccessoryNeedsForBatch, resolveAccessoryNeeds, saveAccessoryOverride } from "./accessory-needs";
import { createDraft } from "./queries";

describe("resolveAccessoryNeeds", () => {
  test("a direct accessoryId recipe row resolves regardless of variant size", async () => {
    await withRollback(async (tx) => {
      const { product, variant, fabric, color } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx, { name: "Hang tag" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 2 });

      const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds([{ sku: variant.sku, qty: 5 }], tx);
      expect(unresolved).toEqual([]);
      expect(neededByAccessoryId.get(accessory.id)).toBe(10);
      void fabric;
      void color;
    });
  });

  test("a sizeGroup recipe row resolves to the matching sized accessory", async () => {
    await withRollback(async (tx) => {
      const { product, variant, fabric, color } = await insertProductVariant(tx); // size M
      await insertAccessory(tx, { name: "Label Ammari XS", sizeGroup: "Label Ammari", size: "XS" });
      const labelM = await insertAccessory(tx, { name: "Label Ammari M", sizeGroup: "Label Ammari", size: "M" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Label Ammari", qtyPerPcs: 1 });

      const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds([{ sku: variant.sku, qty: 3 }], tx);
      expect(unresolved).toEqual([]);
      expect(neededByAccessoryId.get(labelM.id)).toBe(3);
      void fabric;
      void color;
    });
  });

  test("an all-size variant resolves a sizeGroup row to the group's ALLSIZE item", async () => {
    await withRollback(async (tx) => {
      const { fabric, color } = await insertProductVariant(tx);
      const { product, variant } = await insertVariantForProduct(
        tx,
        fabric.id,
        color.id,
        { sizeMode: "all_size" },
        "ALLSIZE",
      );
      const allSizeLabel = await insertAccessory(tx, { name: "Label Polos", sizeGroup: "Label Ammari", size: "ALLSIZE" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Label Ammari", qtyPerPcs: 1 });

      const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds([{ sku: variant.sku, qty: 4 }], tx);
      expect(unresolved).toEqual([]);
      expect(neededByAccessoryId.get(allSizeLabel.id)).toBe(4);
    });
  });

  test("a sizeGroup row with no matching size is reported as unresolved, not thrown", async () => {
    await withRollback(async (tx) => {
      const { product, variant } = await insertProductVariant(tx); // size M, no accessories created for this group
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Grup Hilang", qtyPerPcs: 1 });

      const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds([{ sku: variant.sku, qty: 2 }], tx);
      expect(neededByAccessoryId.size).toBe(0);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ size: "M", sizeGroup: "Grup Hilang" });
    });
  });

  test("sizeGroup matching is case-insensitive (citext)", async () => {
    await withRollback(async (tx) => {
      const { product, variant } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx, { name: "Kancing M", sizeGroup: "KANCING", size: "M" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "kancing", qtyPerPcs: 2 });

      const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds([{ sku: variant.sku, qty: 1 }], tx);
      expect(unresolved).toEqual([]);
      expect(neededByAccessoryId.get(accessory.id)).toBe(2);
    });
  });

  test("two products in the same batch aggregate onto the same accessory", async () => {
    await withRollback(async (tx) => {
      const { fabric, color } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx, { name: "Hang tag bersama" });
      const { product: productA, variant: variantA } = await insertVariantForProduct(tx, fabric.id, color.id);
      const { product: productB, variant: variantB } = await insertVariantForProduct(tx, fabric.id, color.id);
      await tx.insert(productAccessoryRecipes).values([
        { productId: productA.id, accessoryId: accessory.id, qtyPerPcs: 1 },
        { productId: productB.id, accessoryId: accessory.id, qtyPerPcs: 2 },
      ]);

      const { neededByAccessoryId } = await resolveAccessoryNeeds(
        [
          { sku: variantA.sku, qty: 5 },
          { sku: variantB.sku, qty: 3 },
        ],
        tx,
      );
      expect(neededByAccessoryId.get(accessory.id)).toBe(5 * 1 + 3 * 2);
    });
  });
});

describe("getAccessoryNeedsForBatch", () => {
  test("flags a shortage when the effective (overridden) quantity exceeds current stock, and reports unresolved rows", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx, { name: "Kancing Stok" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 1 });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, sizeGroup: "Tidak Ada", qtyPerPcs: 1 });

      const batch = await createDraft({ fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 10, lines: [{ sku: variant.sku, qty: 5 }] }, null, tx);

      const before = await getAccessoryNeedsForBatch(batch.id, tx);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ accessoryId: accessory.id, computedQty: 5, overrideQty: null, effectiveQty: 5, currentStock: 0, shortage: true });
      expect(before.unresolved).toHaveLength(1);

      await saveAccessoryOverride(batch.id, accessory.id, 2, null, tx);
      const afterLowerOverride = await getAccessoryNeedsForBatch(batch.id, tx);
      expect(afterLowerOverride.rows[0]).toMatchObject({ overrideQty: 2, effectiveQty: 2, shortage: true }); // still 0 stock

      await saveAccessoryOverride(batch.id, accessory.id, null, null, tx);
      const afterCleared = await getAccessoryNeedsForBatch(batch.id, tx);
      expect(afterCleared.rows[0]).toMatchObject({ overrideQty: null, effectiveQty: 5 });
    });
  });

  test("saveAccessoryOverride rejects a negative quantity", async () => {
    await withRollback(async (tx) => {
      const { fabric, product, variant } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx, { name: "Kancing Negatif" });
      await tx.insert(productAccessoryRecipes).values({ productId: product.id, accessoryId: accessory.id, qtyPerPcs: 1 });
      const batch = await createDraft({ fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 10, lines: [{ sku: variant.sku, qty: 1 }] }, null, tx);

      await expect(saveAccessoryOverride(batch.id, accessory.id, -1, null, tx)).rejects.toThrow();
    });
  });
});
