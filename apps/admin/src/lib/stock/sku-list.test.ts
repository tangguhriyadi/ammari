import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertProductVariant, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { products, productVariants, stockMovements, type Size } from "@ammari/db/schema";
import { eq } from "drizzle-orm";
import { sizeLabel } from "@ammari/commerce/size-label";
import { listSkus, skuListTable } from "./sku-list";

async function seedStock(tx: TestDatabase, sku: string, qty: number) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: 0, type: "production", refType: "manual" });
}

async function addVariant(tx: TestDatabase, productId: string, fabricId: string, colorId: string, sku: string, size: Size) {
  await tx.insert(productVariants).values({ sku, productId, fabricId, fabricColorId: colorId, closure: "front_zip", size });
}

describe("listSkus", () => {
  test("every variant with product, colour, size, status and physical stock, sizes in wearing order", async () => {
    await withRollback(async (tx) => {
      const { product, fabric, color, variant } = await insertProductVariant(tx);
      const marker = product.code;
      await addVariant(tx, product.id, fabric.id, color.id, `${marker}-XS`, "XS");
      await addVariant(tx, product.id, fabric.id, color.id, `${marker}-XL`, "XL");
      await addVariant(tx, product.id, fabric.id, color.id, `${marker}-S`, "S");
      await seedStock(tx, variant.sku, 7);
      await seedStock(tx, variant.sku, -2);
      await seedStock(tx, `${marker}-XS`, 1);

      const { rows, truncated } = await listSkus({ q: marker }, tx);
      expect(truncated).toBe(false);
      expect(rows.map((row) => [row.size, row.sku, row.stockQty, row.isActive])).toEqual([
        ["XS", `${marker}-XS`, 1, true],
        ["S", `${marker}-S`, 0, true],
        ["M", variant.sku, 5, true],
        ["XL", `${marker}-XL`, 0, true],
      ]);
      expect(rows[0]).toMatchObject({ productName: "Gamis Basic", colorName: "Black" });
      expect(typeof rows[0]!.stockQty).toBe("number");
    });
  });

  test("searches product name, product code, SKU and colour", async () => {
    await withRollback(async (tx) => {
      const { product, fabric, variant } = await insertProductVariant(tx);
      const sage = await insertFabricColor(tx, fabric.id, { name: `Sage ${variant.sku.slice(-6)}` });
      const { variant: other } = await insertVariantForProduct(tx, fabric.id, sage.id, { name: `Gamis Cari ${variant.sku.slice(-6)}` });

      expect((await listSkus({ q: variant.sku.toLowerCase() }, tx)).rows.map((row) => row.sku)).toEqual([variant.sku]);
      expect((await listSkus({ q: `Gamis Cari ${variant.sku.slice(-6)}` }, tx)).rows.map((row) => row.sku)).toEqual([other.sku]);
      expect((await listSkus({ q: `sage ${variant.sku.slice(-6)}` }, tx)).rows.map((row) => row.sku)).toEqual([other.sku]);
      expect((await listSkus({ q: product.code.toLowerCase() }, tx)).rows.map((row) => row.sku)).toEqual([variant.sku]);
    });
  });

  test("a variant counts as active only while its product is active too", async () => {
    await withRollback(async (tx) => {
      const { product, fabric, color, variant } = await insertProductVariant(tx);
      const marker = variant.sku.slice(-8);
      const { product: inactiveProduct, variant: underInactiveProduct } = await insertVariantForProduct(tx, fabric.id, color.id, { name: `Nonaktif ${marker}` });
      await tx.update(products).set({ isActive: false }).where(eq(products.id, inactiveProduct.id));
      await addVariant(tx, product.id, fabric.id, color.id, `${product.code}-L`, "L");
      await tx.update(productVariants).set({ isActive: false }).where(eq(productVariants.sku, `${product.code}-L`));

      const all = await listSkus({ q: product.code }, tx);
      expect(all.rows.map((row) => [row.sku, row.isActive])).toEqual([
        [variant.sku, true],
        [`${product.code}-L`, false],
      ]);
      expect((await listSkus({ q: product.code, activeFilter: "active" }, tx)).rows.map((row) => row.sku)).toEqual([variant.sku]);
      expect((await listSkus({ q: product.code, activeFilter: "inactive" }, tx)).rows.map((row) => row.sku)).toEqual([`${product.code}-L`]);
      expect((await listSkus({ q: `Nonaktif ${marker}`, activeFilter: "inactive" }, tx)).rows.map((row) => row.sku)).toEqual([underInactiveProduct.sku]);
    });
  });
});

describe("skuListTable", () => {
  test("Indonesian header, All Size label, status words", () => {
    expect(
      skuListTable([{ sku: "A-ALLSIZE", productName: "Khimar", colorName: "Hitam", size: "ALLSIZE", isActive: false, stockQty: 3 }], sizeLabel),
    ).toEqual([
      ["Produk", "Warna", "Ukuran", "SKU", "Status", "Stok"],
      ["Khimar", "Hitam", "All Size", "A-ALLSIZE", "Nonaktif", 3],
    ]);
  });
});
