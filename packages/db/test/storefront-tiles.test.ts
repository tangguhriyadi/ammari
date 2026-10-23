import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { fabricColors, fabrics, productImages, products, productVariants, stockMovements } from "../src/schema";
import { getRelatedStorefrontProducts, getStorefrontProductTiles } from "../src/storefront/queries";
import { insertStockReservation } from "./fixtures";
import { withRollback, type TestTx } from "./helpers";

async function seedPublishedProduct(
  tx: TestTx,
  overrides: { colorNames?: string[]; images?: boolean } = {},
) {
  const colorNames = overrides.colorNames ?? ["Beige", "Navy"];
  const [fabric] = await tx.insert(fabrics).values({ name: `Katun ${randomUUID().slice(0, 8)}` }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");

  const colors = [];
  for (const name of colorNames) {
    const [color] = await tx.insert(fabricColors).values({ fabricId: fabric.id, name: `${name} ${randomUUID().slice(0, 4)}` }).returning();
    if (!color) throw new Error("failed to insert color fixture");
    colors.push(color);
  }

  const slug = `tile-product-${randomUUID()}`;
  const [product] = await tx
    .insert(products)
    .values({
      name: `Gamis Tile Test ${randomUUID().slice(0, 8)}`,
      code: `TIL${randomUUID().slice(0, 8).toUpperCase()}`,
      slug,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 269_000,
      isActive: true,
      isPublishedOnStorefront: true,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");

  for (const [index, color] of colors.entries()) {
    await tx.insert(productVariants).values({
      sku: `SKU-TILE-${randomUUID()}`,
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: color.id,
      closure: product.closure,
      size: "M",
      isActive: true,
    });
    if (overrides.images !== false) {
      await tx.insert(productImages).values({
        productId: product.id,
        fabricId: fabric.id,
        fabricColorId: color.id,
        storageKey: `content/${product.id}/${color.id}`,
        width: 800,
        height: 1200,
        altText: `Gamis warna ${color.name}`,
        sortOrder: index,
      });
    }
  }

  return { product, slug, colors, fabric };
}

describe("getStorefrontProductTiles", () => {
  test("returns the raw pricing fields (no discount configured by default)", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx);
      const [tile] = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: null }], tx);
      expect(tile?.pricing).toEqual({
        basePrice: 269_000,
        discountPriceAmount: null,
        discountEnabled: false,
        discountStartsAt: null,
        discountEndsAt: null,
      });
    });
  });

  test("returns a configured discount raw and unresolved, an ended one included, so the caller decides per request", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx);
      const endsAt = new Date(Date.now() - 60_000);
      await tx
        .update(products)
        .set({ discountPriceAmount: 215_000, discountEnabled: true, discountEndsAt: endsAt })
        .where(eq(products.id, fixture.product.id));
      const [tile] = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: null }], tx);
      expect(tile?.pricing).toEqual({
        basePrice: 269_000,
        discountPriceAmount: 215_000,
        discountEnabled: true,
        discountStartsAt: null,
        discountEndsAt: endsAt,
      });
    });
  });

  test("a pinned-colour ref resolves that colour's name and image, no count semantics needed", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx);
      const pinnedColor = fixture.colors[1]!;
      const [tile] = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: pinnedColor.id }], tx);
      expect(tile).toBeDefined();
      expect(tile?.colorName).toBe(pinnedColor.name);
      expect(tile?.image?.fabricColorId).toBe(pinnedColor.id);
      expect(tile?.colorCount).toBe(2);
    });
  });

  test("an unpinned (null fabricColorId) ref resolves the first colour and a total colour count", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx, { colorNames: ["Beige", "Taupe", "Sage"] });
      const [tile] = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: null }], tx);
      expect(tile).toBeDefined();
      expect(tile?.colorName).toBe(fixture.colors[0]!.name);
      expect(tile?.colorCount).toBe(3);
    });
  });

  test("an unpinned ref prefers a GENERAL image over a colour-tagged one, even when the colour image would otherwise sort first", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx, { colorNames: ["Beige", "Navy"], images: false });
      const [fabric] = [fixture.fabric];
      // Insert the colour-tagged image FIRST (sortOrder 0) and the general one SECOND (sortOrder
      // 1) — if the picker just took "whatever sorts/comes first", it would wrongly pick the
      // colour photo for a tile that doesn't pin a colour at all.
      await tx.insert(productImages).values([
        { productId: fixture.product.id, fabricId: fabric.id, fabricColorId: fixture.colors[1]!.id, storageKey: "x/navy", width: 800, height: 1200, sortOrder: 0 },
        { productId: fixture.product.id, fabricId: fabric.id, fabricColorId: null, storageKey: "x/general", width: 800, height: 1200, sortOrder: 1 },
      ]);

      const [tile] = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: null }], tx);
      expect(tile?.image?.storageKey).toBe("x/general");
      expect(tile?.image?.fabricColorId).toBeNull();
    });
  });

  test("soldOut is true until some active variant, in any colour, has stock; a pinned tile reads the whole product", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx);
      const refs = [
        { productId: fixture.product.id, fabricColorId: null },
        { productId: fixture.product.id, fabricColorId: fixture.colors[0]!.id },
      ];
      expect((await getStorefrontProductTiles(refs, tx)).map((tile) => tile.soldOut)).toEqual([true, true]);

      // Stock for ONE variant (the second colour's) makes the product, and every tile of it, buyable.
      const [variant] = await tx.select({ sku: productVariants.sku }).from(productVariants).where(eq(productVariants.fabricColorId, fixture.colors[1]!.id));
      await tx.insert(stockMovements).values({ sku: variant!.sku, qty: 3, valueAmount: 144_000, type: "production", refType: "manual" });
      expect((await getStorefrontProductTiles(refs, tx)).map((tile) => tile.soldOut)).toEqual([false, false]);
    });
  });

  test("soldOut also counts active, unexpired stock holds: a product whose every piece is held reads sold out", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx, { colorNames: ["Beige"] });
      const refs = [{ productId: fixture.product.id, fabricColorId: null }];
      const [variant] = await tx.select({ sku: productVariants.sku }).from(productVariants).where(eq(productVariants.productId, fixture.product.id));
      await tx.insert(stockMovements).values({ sku: variant!.sku, qty: 2, valueAmount: 96_000, type: "production", refType: "manual" });

      await insertStockReservation(tx, { sku: variant!.sku, qty: 2, expiresAt: new Date(Date.now() - 60_000) });
      expect((await getStorefrontProductTiles(refs, tx)).map((tile) => tile.soldOut)).toEqual([false]);

      await insertStockReservation(tx, { sku: variant!.sku, qty: 2 });
      expect((await getStorefrontProductTiles(refs, tx)).map((tile) => tile.soldOut)).toEqual([true]);
    });
  });

  test("a ref to a deactivated or unpublished product is omitted, never throws", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedPublishedProduct(tx);
      await tx.update(products).set({ isPublishedOnStorefront: false }).where(eq(products.id, fixture.product.id));

      const tiles = await getStorefrontProductTiles([{ productId: fixture.product.id, fabricColorId: null }], tx);
      expect(tiles).toEqual([]);
    });
  });

  test("a ref to a nonexistent product id is omitted, never throws", async () => {
    await withRollback(async (tx) => {
      const tiles = await getStorefrontProductTiles([{ productId: randomUUID(), fabricColorId: null }], tx);
      expect(tiles).toEqual([]);
    });
  });
});

describe("getRelatedStorefrontProducts", () => {
  test("excludes the given slug and returns other published products", async () => {
    await withRollback(async (tx) => {
      const self = await seedPublishedProduct(tx);
      const other = await seedPublishedProduct(tx);

      const related = await getRelatedStorefrontProducts({ excludeSlug: self.slug, limit: 5 }, tx);
      expect(related.some((tile) => tile.productId === self.product.id)).toBe(false);
      expect(related.some((tile) => tile.productId === other.product.id)).toBe(true);
    });
  });

  test("returns [] for an unknown slug", async () => {
    await withRollback(async (tx) => {
      const related = await getRelatedStorefrontProducts({ excludeSlug: `nonexistent-${randomUUID()}`, limit: 5 }, tx);
      expect(related).toEqual([]);
    });
  });

  test("respects the limit", async () => {
    await withRollback(async (tx) => {
      const self = await seedPublishedProduct(tx);
      await seedPublishedProduct(tx);
      await seedPublishedProduct(tx);

      const related = await getRelatedStorefrontProducts({ excludeSlug: self.slug, limit: 1 }, tx);
      expect(related.length).toBeLessThanOrEqual(1);
    });
  });
});
