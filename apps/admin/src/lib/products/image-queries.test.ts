import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { testDb, withRollback } from "@ammari/db/test-utils";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { fabricColors, fabrics, productImages, products, productVariants } from "@ammari/db/schema";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import type { Database } from "./db";
import { FieldError } from "./errors";
import { createFabricColor } from "./fabric-queries";
import { createProduct, addVariants } from "./queries";
import {
  deleteProductImage,
  getColorsMissingPhotos,
  reorderProductImages,
  setProductThumbnail,
  uploadProductImage,
} from "./image-queries";

const ACTOR_ID = null;

async function createFabricFixture(tx: Database, overrides: Partial<typeof fabrics.$inferInsert> = {}) {
  const [fabric] = await tx.insert(fabrics).values({ name: `Bahan ${randomUUID().slice(0, 8)}`, ...overrides }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

async function createFabricColorFixture(tx: Database, fabricId: string, overrides: { name?: string; hex?: string } = {}) {
  return createFabricColor(fabricId, { name: overrides.name ?? `Sage ${randomUUID().slice(0, 8)}`, hex: overrides.hex }, ACTOR_ID, tx);
}

async function createProductFixture(tx: Database, fabricId: string, overrides: Partial<Parameters<typeof createProduct>[0]> = {}) {
  const name = overrides.name ?? `Contoh Gamis ${randomUUID().slice(0, 6)}`;
  return createProduct(
    {
      name,
      code: overrides.code ?? generateProductCode(name),
      slug: overrides.slug ?? generateSlug(name),
      fabricId,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 269_000,
      isActive: true,
      ...overrides,
    },
    ACTOR_ID,
    tx,
  );
}

async function jpegBuffer(width = 20, height = 20): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
}

let memoryStorage: InMemoryStorageClient;

beforeEach(() => {
  memoryStorage = new InMemoryStorageClient();
  __setStorageClientForTests(memoryStorage);
});

afterEach(() => {
  __setStorageClientForTests(undefined);
});

describe("uploadProductImage", () => {
  test("creates one row and 3 objects (400/800/1600) per image", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id);

      const image = await uploadProductImage(
        { productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer(), altText: "Tampak depan" },
        ACTOR_ID,
        tx,
      );

      expect(image.fabricColorId).toBe(color.id);
      expect(image.altText).toBe("Tampak depan");
      expect(image.width).toBe(20);
      expect(image.height).toBe(20);

      const keys = new Set([...memoryStorage.objects.keys()].filter((key) => key.startsWith(image.storageKey)));
      expect(keys).toEqual(
        new Set([`${image.storageKey}/400.webp`, `${image.storageKey}/800.webp`, `${image.storageKey}/1600.webp`]),
      );
    });
  });

  test("rejects a color that belongs to a DIFFERENT fabric, and cleans up the objects it already wrote", async () => {
    await withRollback(async (tx) => {
      const fabricA = await createFabricFixture(tx, { name: "Poka" });
      const fabricB = await createFabricFixture(tx, { name: "Marina" });
      const colorFromB = await createFabricColorFixture(tx, fabricB.id);
      const productOnA = await createProductFixture(tx, fabricA.id);

      await expect(
        uploadProductImage(
          { productId: productOnA.id, fabricColorId: colorFromB.id, fileBuffer: await jpegBuffer() },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(FieldError);

      expect(memoryStorage.objects.size).toBe(0);
    });
  });

  test("the first image uploaded to a thumbnail-less product becomes the thumbnail", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);

      const image = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      expect(after?.thumbnailImageId).toBe(image.id);
    });
  });

  test("a second upload does NOT override an already-set thumbnail", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);

      const first = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      expect(after?.thumbnailImageId).toBe(first.id);
    });
  });

  test("sortOrder is appended within the (product, color) group, independently per group", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id);

      const generalA = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const colorA = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const generalB = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      expect(generalA.sortOrder).toBe(0);
      expect(colorA.sortOrder).toBe(0); // its own group, independent of the general group's count
      expect(generalB.sortOrder).toBe(1);
    });
  });
});

describe("deleteProductImage", () => {
  test("removes the row and its 3 storage objects", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      const imageA = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await deleteProductImage(imageA.id, ACTOR_ID, tx);

      const remaining = await tx.select().from(productImages).where(eq(productImages.id, imageA.id));
      expect(remaining).toHaveLength(0);
      const keys = [...memoryStorage.objects.keys()].filter((key) => key.startsWith(imageA.storageKey));
      expect(keys).toHaveLength(0);
    });
  });

  test("deleting the current thumbnail falls back to the first remaining general image", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      const thumbnail = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const fallback = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await deleteProductImage(thumbnail.id, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      expect(after?.thumbnailImageId).toBe(fallback.id);
    });
  });

  test("falls back to the first image of the alphabetically-first color when no general image remains", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const colorMocca = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const colorSage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const product = await createProductFixture(tx, fabric.id);

      const thumbnail = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const moccaImage = await uploadProductImage({ productId: product.id, fabricColorId: colorMocca.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const sageImage = await uploadProductImage({ productId: product.id, fabricColorId: colorSage.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await deleteProductImage(thumbnail.id, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      // "Mocca" sorts before "Sage" — the fallback is the first image of the alphabetically
      // first color, not insertion order.
      expect(after?.thumbnailImageId).toBe(moccaImage.id);
      expect(after?.thumbnailImageId).not.toBe(sageImage.id);
    });
  });

  test("falls back to null when no images remain at all", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      const onlyImage = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await deleteProductImage(onlyImage.id, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      expect(after?.thumbnailImageId).toBeNull();
    });
  });

  test("refuses to delete the last photo of a color while the product is active and the color has an active variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { isActive: false }); // image first, then activate below
      const image = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);
      await tx.update(products).set({ isActive: true }).where(eq(products.id, product.id));

      await expect(deleteProductImage(image.id, ACTOR_ID, tx)).rejects.toThrow(/foto terakhir/);
    });
  });

  test("allows deleting the last photo of a color when the product is INACTIVE", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const image = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      await expect(deleteProductImage(image.id, ACTOR_ID, tx)).resolves.toBeUndefined();
    });
  });

  test("allows deleting the last photo of a color with no active variant, even on an active product", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { isActive: true });
      const image = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      // No variants at all for this color — the required-photo rule only bites colors that
      // actually have an active variant.

      await expect(deleteProductImage(image.id, ACTOR_ID, tx)).resolves.toBeUndefined();
    });
  });
});

describe("reorderProductImages", () => {
  test("applies the new order's indices as sort_order", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      const a = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const b = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await reorderProductImages({ productId: product.id, fabricColorId: null, orderedImageIds: [b.id, a.id] }, ACTOR_ID, tx);

      const rows = await tx.select().from(productImages).where(eq(productImages.productId, product.id));
      expect(rows.find((r) => r.id === b.id)?.sortOrder).toBe(0);
      expect(rows.find((r) => r.id === a.id)?.sortOrder).toBe(1);
    });
  });

  test("rejects a reorder list that doesn't match the group's actual images", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await expect(
        reorderProductImages({ productId: product.id, fabricColorId: null, orderedImageIds: [randomUUID()] }, ACTOR_ID, tx),
      ).rejects.toThrow();
    });
  });
});

describe("setProductThumbnail", () => {
  test("sets the thumbnail to an image of this product", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id);
      const image = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      const other = await uploadProductImage({ productId: product.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await setProductThumbnail(product.id, other.id, ACTOR_ID, tx);

      const [after] = await tx.select().from(products).where(eq(products.id, product.id)).limit(1);
      expect(after?.thumbnailImageId).toBe(other.id);
      expect(after?.thumbnailImageId).not.toBe(image.id);
    });
  });

  test("rejects an image belonging to a DIFFERENT product", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const productA = await createProductFixture(tx, fabric.id);
      const productB = await createProductFixture(tx, fabric.id);
      const imageOfB = await uploadProductImage({ productId: productB.id, fabricColorId: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await expect(setProductThumbnail(productA.id, imageOfB.id, ACTOR_ID, tx)).rejects.toThrow(/bukan milik produk ini/);
    });
  });
});

describe("getColorsMissingPhotos", () => {
  test("returns a color with an active variant and zero images", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      // Created INACTIVE so addVariants below creates an ACTIVE variant (its own auto-inactive
      // rule only kicks in for an active product) — then flipped to active directly (bypassing
      // updateProduct's own photo check) to reach exactly the state this test is about: an
      // active product, an active variant, and no photo for that variant's color.
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);
      await tx.update(products).set({ isActive: true }).where(eq(products.id, product.id));

      const missing = await getColorsMissingPhotos(product.id, tx);
      expect(missing.map((c) => c.name)).toContain("Mocca");
    });
  });

  test("excludes a color that already has an image", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id);
      // Image uploaded BEFORE addVariants — so the color already has a photo at the moment the
      // variant is created, and the variant comes in active normally (not auto-deactivated).
      await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      const missing = await getColorsMissingPhotos(product.id, tx);
      expect(missing.map((c) => c.name)).not.toContain("Mocca");
    });
  });

  test("excludes a color whose only variant is inactive", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id);
      const { created: [variant] } = await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);
      if (!variant) throw new Error("expected a variant to be created");
      await tx.update(productVariants).set({ isActive: false }).where(eq(productVariants.sku, variant.sku));

      const missing = await getColorsMissingPhotos(product.id, tx);
      expect(missing.map((c) => c.name)).not.toContain("Mocca");
    });
  });
});

describe("concurrent deletes of the same color's last two photos are serialized", () => {
  test("exactly one of two concurrent deletes succeeds, and the required-photo rule still holds afterward", async () => {
    const fabric = await createFabricFixture(testDb);
    const color = await createFabricColorFixture(testDb, fabric.id);
    const product = await createProductFixture(testDb, fabric.id, { isActive: true });
    // Images uploaded BEFORE addVariants — so the color already has photos when the variant is
    // created, and it comes in active normally (addVariants would otherwise auto-deactivate a
    // new variant for a photo-less color on an active product, which would defeat this test:
    // the "last photo" refusal only fires for a color with an ACTIVE variant).
    const imageA = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, testDb);
    const imageB = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, testDb);
    await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, testDb);

    try {
      const outcomes = await Promise.allSettled([
        deleteProductImage(imageA.id, ACTOR_ID, testDb),
        deleteProductImage(imageB.id, ACTOR_ID, testDb),
      ]);

      const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const failed = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/foto terakhir/);

      const remaining = await testDb.select().from(productImages).where(eq(productImages.productId, product.id));
      expect(remaining).toHaveLength(1);
    } finally {
      // This test commits real transactions (needed for genuine cross-transaction row-lock
      // contention) — withRollback's single shared transaction can't exercise that, so cleanup
      // here is manual rather than an automatic rollback. The surviving image is very likely
      // still the product's thumbnail (deleteProductImage's own fallback logic points it there)
      // — null it out first, since products_thumbnail_image_id_fk is ON DELETE RESTRICT.
      await testDb.update(products).set({ thumbnailImageId: null }).where(eq(products.id, product.id));
      await testDb.delete(productImages).where(eq(productImages.productId, product.id));
      await testDb.delete(productVariants).where(eq(productVariants.productId, product.id));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});
