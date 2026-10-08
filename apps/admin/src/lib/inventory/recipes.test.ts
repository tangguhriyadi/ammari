import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant } from "@ammari/db/test-fixtures";
import { listRecipeForProduct, saveRecipeForProduct } from "./recipes";

describe("saveRecipeForProduct", () => {
  test("saves a mix of accessory rows and size-group rows", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const hangTag = await insertAccessory(tx, { name: "Hang tag" });

      const saved = await saveRecipeForProduct(
        product.id,
        [
          { accessoryId: hangTag.id, qtyPerPcs: 1 },
          { sizeGroup: "Label Ammari", qtyPerPcs: 1 },
        ],
        null,
        tx,
      );
      expect(saved).toHaveLength(2);

      const rows = await listRecipeForProduct(product.id, tx);
      expect(rows.find((r) => r.accessoryId === hangTag.id)?.qtyPerPcs).toBe(1);
      expect(rows.find((r) => r.sizeGroup === "Label Ammari")?.accessoryId).toBeNull();
    });
  });

  test("rejects a row with both accessoryId and sizeGroup set", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx);
      await expect(
        saveRecipeForProduct(product.id, [{ accessoryId: accessory.id, sizeGroup: "X", qtyPerPcs: 1 }], null, tx),
      ).rejects.toThrow(/satu aksesoris ATAU satu grup/);
    });
  });

  test("rejects a row with neither accessoryId nor sizeGroup set", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await expect(saveRecipeForProduct(product.id, [{ qtyPerPcs: 1 }], null, tx)).rejects.toThrow(/satu aksesoris ATAU satu grup/);
    });
  });

  test("rejects a non-positive qtyPerPcs", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx);
      await expect(
        saveRecipeForProduct(product.id, [{ accessoryId: accessory.id, qtyPerPcs: 0 }], null, tx),
      ).rejects.toThrow(/lebih dari 0/);
    });
  });

  test("rejects the same accessory appearing twice in one submission", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx);
      await expect(
        saveRecipeForProduct(
          product.id,
          [
            { accessoryId: accessory.id, qtyPerPcs: 1 },
            { accessoryId: accessory.id, qtyPerPcs: 2 },
          ],
          null,
          tx,
        ),
      ).rejects.toThrow(/sudah ada di baris lain/);
    });
  });

  test("is a full replace — saving a shorter list removes the rows that were dropped", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const first = await insertAccessory(tx);
      const second = await insertAccessory(tx);

      await saveRecipeForProduct(
        product.id,
        [
          { accessoryId: first.id, qtyPerPcs: 1 },
          { accessoryId: second.id, qtyPerPcs: 2 },
        ],
        null,
        tx,
      );
      await saveRecipeForProduct(product.id, [{ accessoryId: second.id, qtyPerPcs: 3 }], null, tx);

      const rows = await listRecipeForProduct(product.id, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.accessoryId).toBe(second.id);
      expect(rows[0]?.qtyPerPcs).toBe(3);
    });
  });

  test("saving an empty list clears the recipe entirely", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const accessory = await insertAccessory(tx);
      await saveRecipeForProduct(product.id, [{ accessoryId: accessory.id, qtyPerPcs: 1 }], null, tx);
      await saveRecipeForProduct(product.id, [], null, tx);
      const rows = await listRecipeForProduct(product.id, tx);
      expect(rows).toHaveLength(0);
    });
  });
});
