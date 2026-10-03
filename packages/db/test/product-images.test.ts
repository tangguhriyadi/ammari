import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fabricColors, fabrics, productImages, products } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";

async function insertFabricFixture(tx: TestTx, overrides: Partial<typeof fabrics.$inferInsert> = {}) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon", ...overrides }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

async function insertFabricColorFixture(tx: TestTx, fabricId: string, overrides: Partial<typeof fabricColors.$inferInsert> = {}) {
  const [color] = await tx
    .insert(fabricColors)
    .values({ fabricId, name: `Sage ${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  if (!color) throw new Error("failed to insert fabric color fixture");
  return color;
}

async function insertProductFixture(tx: TestTx, fabricId: string, overrides: Partial<typeof products.$inferInsert> = {}) {
  const [product] = await tx
    .insert(products)
    .values({
      name: "Gamis Test",
      code: `CODE${randomUUID().slice(0, 8).toUpperCase()}`,
      slug: `gamis-test-${randomUUID()}`,
      fabricId,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 259_000,
      ...overrides,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");
  return product;
}

function imageValues(overrides: Partial<typeof productImages.$inferInsert> & { productId: string; fabricId: string }) {
  return {
    storageKey: `local/products/${overrides.productId}/${randomUUID()}`,
    width: 800,
    height: 1200,
    ...overrides,
  };
}

/** Same unwrapping product-variants.test.ts uses — drizzle-orm wraps the driver error and puts
 * the real Postgres code/message on `.cause`. */
async function causeOf(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { message: String(cause), code: (cause as { code?: string } | undefined)?.code };
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("an image's color must belong to its own product's fabric", () => {
  test("rejects a fabric_color_id from a DIFFERENT fabric than the product's", async () => {
    await withRollback(async (tx) => {
      const fabricA = await insertFabricFixture(tx, { name: "Poka" });
      const fabricB = await insertFabricFixture(tx, { name: "Marina" });
      const colorFromB = await insertFabricColorFixture(tx, fabricB.id);
      const productOnA = await insertProductFixture(tx, fabricA.id);

      const { code } = await causeOf(
        tx.insert(productImages).values(
          imageValues({ productId: productOnA.id, fabricId: fabricA.id, fabricColorId: colorFromB.id }),
        ),
      );
      expect(code).toBe("23503");
    });
  });

  test("accepts a fabric_color_id that genuinely belongs to the product's fabric", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id);
      await expect(
        tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: color.id })),
      ).resolves.not.toThrow();
    });
  });

  test("accepts a null fabric_color_id (a general image) regardless of fabric_id", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      await expect(
        tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null })),
      ).resolves.not.toThrow();
    });
  });
});

describe("a product's fabric cannot change while it still has images", () => {
  test("rejects UPDATE products SET fabric_id after an image exists", async () => {
    await withRollback(async (tx) => {
      const oldFabric = await insertFabricFixture(tx, { name: "Poka" });
      const newFabric = await insertFabricFixture(tx, { name: "Marina" });
      const product = await insertProductFixture(tx, oldFabric.id);
      await tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: oldFabric.id, fabricColorId: null }));

      const { code } = await causeOf(
        tx.update(products).set({ fabricId: newFabric.id }).where(eq(products.id, product.id)),
      );
      expect(code).toBe("23503");
    });
  });
});

describe("width/height must be positive", () => {
  test("rejects width = 0", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      await expect(
        tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null, width: 0 })),
      ).rejects.toThrow();
    });
  });

  test("rejects a negative height", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      await expect(
        tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null, height: -1 })),
      ).rejects.toThrow();
    });
  });
});

describe("products.thumbnail_image_id must reference an image of the SAME product", () => {
  test("rejects an image belonging to a DIFFERENT product", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const productA = await insertProductFixture(tx, fabric.id);
      const productB = await insertProductFixture(tx, fabric.id);
      const [imageOfB] = await tx
        .insert(productImages)
        .values(imageValues({ productId: productB.id, fabricId: fabric.id, fabricColorId: null }))
        .returning();
      if (!imageOfB) throw new Error("failed to insert image fixture");

      const { code } = await causeOf(
        tx.update(products).set({ thumbnailImageId: imageOfB.id }).where(eq(products.id, productA.id)),
      );
      // 23503 — the hand-authored composite FK (thumbnail_image_id, id) ->
      // product_images(id, product_id) has no matching row: imageOfB's product_id is
      // productB.id, not productA.id.
      expect(code).toBe("23503");
    });
  });

  test("accepts an image that genuinely belongs to the product", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      const [image] = await tx
        .insert(productImages)
        .values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null }))
        .returning();
      if (!image) throw new Error("failed to insert image fixture");

      await expect(
        tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id)),
      ).resolves.not.toThrow();
    });
  });

  test("deleting the current thumbnail image is refused (ON DELETE RESTRICT) until the column is nulled first", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      const [image] = await tx
        .insert(productImages)
        .values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null }))
        .returning();
      if (!image) throw new Error("failed to insert image fixture");
      await tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id));

      const { code } = await causeOf(tx.delete(productImages).where(eq(productImages.id, image.id)));
      expect(code).toBe("23503");
    });
  });

  test("deleting the image succeeds once the thumbnail reference is nulled first (the app-level order)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      const [image] = await tx
        .insert(productImages)
        .values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null }))
        .returning();
      if (!image) throw new Error("failed to insert image fixture");
      await tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id));

      await tx.update(products).set({ thumbnailImageId: null }).where(eq(products.id, product.id));
      await expect(tx.delete(productImages).where(eq(productImages.id, image.id))).resolves.not.toThrow();
    });
  });
});

describe("deleting a product cascades to its images", () => {
  test("images are removed when their product is deleted", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      await tx.insert(productImages).values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null }));

      await tx.delete(products).where(eq(products.id, product.id));
      const remaining = await tx.select().from(productImages).where(eq(productImages.productId, product.id));
      expect(remaining).toHaveLength(0);
    });
  });

  // The self-referencing case: products.thumbnail_image_id points at one of the product's OWN
  // images, then the product itself is deleted. This is the scenario products_thumbnail_image_id_fk
  // (ON DELETE RESTRICT) exists to guard against a direct image delete, but a product-delete's
  // CASCADE to product_images must still succeed — by the time the cascade's nested delete of
  // product_images fires the RESTRICT check, the referencing products row is already gone within
  // the same command, so the check's snapshot doesn't see it (database-reviewer finding).
  test("succeeds even when the deleted product's own thumbnail_image_id points at its own image", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id);
      const [image] = await tx
        .insert(productImages)
        .values(imageValues({ productId: product.id, fabricId: fabric.id, fabricColorId: null }))
        .returning();
      if (!image) throw new Error("failed to insert image fixture");
      await tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id));

      await expect(tx.delete(products).where(eq(products.id, product.id))).resolves.not.toThrow();
      const remainingImages = await tx.select().from(productImages).where(eq(productImages.productId, product.id));
      expect(remainingImages).toHaveLength(0);
      const remainingProducts = await tx.select().from(products).where(eq(products.id, product.id));
      expect(remainingProducts).toHaveLength(0);
    });
  });
});
