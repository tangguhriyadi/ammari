import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { testDb, withRollback, type TestTx } from "@ammari/db/test-utils";
import { generateProductCode, generateSku, generateSlug } from "@ammari/db/catalog";
import { auditLog, productVariants } from "@ammari/db/schema";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import { FieldError } from "./errors";
import { createFabric, createFabricColor, setFabricColorActive, updateFabricColor } from "./fabric-queries";
import { uploadProductImage } from "./image-queries";
import {
  addVariants,
  createProduct,
  getCurrentCostAssumption,
  getProductDetail,
  listProducts,
  setVariantActive,
  updateProduct,
  updateVariantsBulk,
} from "./queries";

async function jpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
}

const ACTOR_ID = null; // audit_log.actor_staff_user_id is nullable; no staff fixture needed here.

beforeEach(() => {
  __setStorageClientForTests(new InMemoryStorageClient());
});

afterEach(() => {
  __setStorageClientForTests(undefined);
});

async function createFabricFixture(tx: TestTx, overrides: Partial<Parameters<typeof createFabric>[0]> = {}) {
  return createFabric({ name: `Bahan ${randomUUID().slice(0, 8)}`, ...overrides }, ACTOR_ID, tx);
}

async function createFabricColorFixture(
  tx: TestTx,
  fabricId: string,
  overrides: Partial<Parameters<typeof createFabricColor>[1]> = {},
) {
  return createFabricColor(fabricId, { name: `Sage ${randomUUID().slice(0, 8)}`, ...overrides }, ACTOR_ID, tx);
}

// "Contoh Gamis X" placeholder names — never a fabric name (Poka/Marina stay fabric-only, see
// db:seed:dev and docs/SPEC.md).
async function createProductFixture(
  tx: TestTx,
  fabricId: string,
  overrides: Partial<Parameters<typeof createProduct>[0]> = {},
) {
  const name = overrides.name ?? `Contoh Gamis ${randomUUID().slice(0, 6)}`;
  const code = overrides.code ?? generateProductCode(name);
  return createProduct(
    {
      name,
      code,
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

describe("addVariants", () => {
  test("2 colors x 3 sizes in one call creates 6 variants", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const mocca = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id);

      const { created } = await addVariants(
        {
          productId: product.id,
          selections: [
            { fabricColorId: sage.id, sizes: ["S", "M", "L"] },
            { fabricColorId: mocca.id, sizes: ["S", "M", "L"] },
          ],
        },
        ACTOR_ID,
        tx,
      );

      expect(created).toHaveLength(6);
      expect(created.map((v) => v.sku).sort()).toEqual(
        [
          generateSku({ code: product.code, closure: "front_zip", color: "Sage", size: "S" }),
          generateSku({ code: product.code, closure: "front_zip", color: "Sage", size: "M" }),
          generateSku({ code: product.code, closure: "front_zip", color: "Sage", size: "L" }),
          generateSku({ code: product.code, closure: "front_zip", color: "Mocca", size: "S" }),
          generateSku({ code: product.code, closure: "front_zip", color: "Mocca", size: "M" }),
          generateSku({ code: product.code, closure: "front_zip", color: "Mocca", size: "L" }),
        ].sort(),
      );
    });
  });

  test("a single batch call writes exactly ONE audit_log entry, not one per variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const mocca = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id);

      await addVariants(
        {
          productId: product.id,
          selections: [
            { fabricColorId: sage.id, sizes: ["S", "M"] },
            { fabricColorId: mocca.id, sizes: ["S", "M"] },
          ],
        },
        ACTOR_ID,
        tx,
      );

      const entries = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "product_variant"))
        .then((rows) => rows.filter((row) => row.entityId === product.id));
      expect(entries).toHaveLength(1);
      expect((entries[0]?.after as { skus: string[] } | null)?.skus).toHaveLength(4);
    });
  });

  test("a failure for one color rejects the ENTIRE batch, including colors that would have succeeded (atomic)", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const mocca = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id);
      await setFabricColorActive(mocca.id, false, ACTOR_ID, tx);

      await expect(
        addVariants(
          {
            productId: product.id,
            selections: [
              { fabricColorId: sage.id, sizes: ["M"] },
              { fabricColorId: mocca.id, sizes: ["M"] },
            ],
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(FieldError);

      // Sage's variant must NOT have been created either — the whole batch rolled back together.
      const detail = await getProductDetail(product.id, tx);
      expect(detail?.variants).toHaveLength(0);
    });
  });

  test("pinpoints which color+size already exists when re-submitting a batch", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const product = await createProductFixture(tx, fabric.id);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: sage.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      try {
        await addVariants({ productId: product.id, selections: [{ fabricColorId: sage.id, sizes: ["M"] }] }, ACTOR_ID, tx);
        throw new Error("expected addVariants to reject the duplicate color+size");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).message).toContain("Sage");
        expect((error as FieldError).message).toContain("M");
      }
    });
  });

  test("a 'sized' product rejects an ALLSIZE size with a friendly FieldError", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { sizeMode: "sized" });
      await expect(
        addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["ALLSIZE"] }] }, ACTOR_ID, tx),
      ).rejects.toThrow(FieldError);
    });
  });

  test("an 'all_size' product accepts exactly one ALLSIZE variant per color", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { sizeMode: "all_size" });
      const { created } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["ALLSIZE"] }] },
        ACTOR_ID,
        tx,
      );
      expect(created).toHaveLength(1);
      expect(created[0]?.size).toBe("ALLSIZE");
    });
  });

  test("duplicate color+size for the same product surfaces as a field error, not a crash", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);
      await expect(
        addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx),
      ).rejects.toThrow(FieldError);
    });
  });

  test("rejects a color that belongs to a DIFFERENT fabric than the product's", async () => {
    await withRollback(async (tx) => {
      const fabricA = await createFabricFixture(tx);
      const fabricB = await createFabricFixture(tx);
      const colorFromB = await createFabricColorFixture(tx, fabricB.id);
      const productOnA = await createProductFixture(tx, fabricA.id);
      await expect(
        addVariants({ productId: productOnA.id, selections: [{ fabricColorId: colorFromB.id, sizes: ["M"] }] }, ACTOR_ID, tx),
      ).rejects.toThrow(FieldError);
    });
  });

  test("rejects a deactivated color for a NEW variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id);
      await setFabricColorActive(color.id, false, ACTOR_ID, tx);
      await expect(
        addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx),
      ).rejects.toThrow(FieldError);
    });
  });

  test("renaming a fabric color does NOT change an already-created SKU", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const product = await createProductFixture(tx, fabric.id);
      const { created: [variant] } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );
      const originalSku = variant?.sku;
      expect(originalSku).toContain("SAGE");

      await updateFabricColor(color.id, { name: "Forest Green" }, ACTOR_ID, tx);

      const detail = await getProductDetail(product.id, tx);
      expect(detail?.variants).toHaveLength(1);
      expect(detail?.variants[0]?.sku).toBe(originalSku);
      expect(detail?.variants[0]?.colorName).toBe("Forest Green");
    });
  });
});

describe("addVariants — required-photo invariant", () => {
  test("creates new variants INACTIVE for a photo-less color on an active product, and reports it in inactiveColorNames", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id, { isActive: true });

      const { created, inactiveColorNames } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );

      expect(created.every((variant) => variant.isActive === false)).toBe(true);
      expect(inactiveColorNames).toEqual(["Mocca"]);
    });
  });

  test("creates new variants ACTIVE when the color already has a photo", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const product = await createProductFixture(tx, fabric.id, { isActive: true });
      await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      const { created, inactiveColorNames } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );

      expect(created.every((variant) => variant.isActive === true)).toBe(true);
      expect(inactiveColorNames).toEqual([]);
    });
  });

  test("creates new variants ACTIVE normally when the product itself is inactive", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id, { isActive: false });

      const { created, inactiveColorNames } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );

      expect(created.every((variant) => variant.isActive === true)).toBe(true);
      expect(inactiveColorNames).toEqual([]);
    });
  });
});

describe("createProduct", () => {
  test("a duplicate slug surfaces as a field error on 'slug'", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const slug = `dup-slug-${randomUUID()}`;
      await createProductFixture(tx, fabric.id, { slug });
      try {
        await createProductFixture(tx, fabric.id, { slug });
        throw new Error("expected createProduct to reject a duplicate slug");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("slug");
      }
    });
  });

  test("a duplicate code surfaces as a field error on 'code'", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const code = `DUPCODE${randomUUID().slice(0, 6).toUpperCase()}`;
      await createProductFixture(tx, fabric.id, { code });
      try {
        await createProductFixture(tx, fabric.id, { code });
        throw new Error("expected createProduct to reject a duplicate code");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("code");
      }
    });
  });
});

describe("updateProduct", () => {
  test("does not accept sizeMode — immutable after creation by construction, not by a runtime check", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id, { sizeMode: "sized" });
      const updateInput: Parameters<typeof updateProduct>[1] = {
        name: product.name,
        slug: product.slug,
        fabricId: product.fabricId,
        closure: product.closure,
        basePrice: product.basePrice,
        isActive: product.isActive,
      };
      // @ts-expect-error -- sizeMode is intentionally not part of UpdateProductInput
      expect(updateInput.sizeMode).toBeUndefined();
      const updated = await updateProduct(product.id, updateInput, ACTOR_ID, tx);
      expect(updated.sizeMode).toBe("sized");
    });
  });

  test("allows changing the fabric when the product has no variants yet", async () => {
    await withRollback(async (tx) => {
      const fabricA = await createFabricFixture(tx);
      const fabricB = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabricA.id);
      const updated = await updateProduct(
        product.id,
        {
          name: product.name,
          slug: product.slug,
          fabricId: fabricB.id,
          closure: product.closure,
          basePrice: product.basePrice,
          isActive: product.isActive,
        },
        ACTOR_ID,
        tx,
      );
      expect(updated.fabricId).toBe(fabricB.id);
    });
  });

  test("rejects changing the fabric once the product has a variant, with a friendly FieldError", async () => {
    await withRollback(async (tx) => {
      const fabricA = await createFabricFixture(tx);
      const fabricB = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabricA.id);
      const product = await createProductFixture(tx, fabricA.id);
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      try {
        await updateProduct(
          product.id,
          {
            name: product.name,
            slug: product.slug,
            fabricId: fabricB.id,
            closure: product.closure,
            basePrice: product.basePrice,
            isActive: product.isActive,
          },
          ACTOR_ID,
          tx,
        );
        throw new Error("expected updateProduct to reject changing the fabric");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("fabricId");
      }
    });
  });

  test("allows changing the closure when the product has no variants yet", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const product = await createProductFixture(tx, fabric.id, { closure: "front_zip" });
      const updated = await updateProduct(
        product.id,
        {
          name: product.name,
          slug: product.slug,
          fabricId: product.fabricId,
          closure: "back_zip",
          basePrice: product.basePrice,
          isActive: product.isActive,
        },
        ACTOR_ID,
        tx,
      );
      expect(updated.closure).toBe("back_zip");
    });
  });

  test("rejects changing the closure once the product has a variant, with a friendly FieldError", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { closure: "front_zip" });
      await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

      try {
        await updateProduct(
          product.id,
          {
            name: product.name,
            slug: product.slug,
            fabricId: product.fabricId,
            closure: "back_zip",
            basePrice: product.basePrice,
            isActive: product.isActive,
          },
          ACTOR_ID,
          tx,
        );
        throw new Error("expected updateProduct to reject changing the closure");
      } catch (error) {
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("closure");
      }
    });
  });

  describe("required-photo invariant", () => {
    test("refuses to activate when a color with an active variant has no photo, naming the color", async () => {
      await withRollback(async (tx) => {
        const fabric = await createFabricFixture(tx);
        const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
        // Inactive first so addVariants' own rule doesn't ALSO deactivate the variant — this
        // test is specifically about updateProduct's check, isolated from addVariants'.
        const product = await createProductFixture(tx, fabric.id, { isActive: false });
        await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

        await expect(
          updateProduct(
            product.id,
            {
              name: product.name,
              slug: product.slug,
              fabricId: product.fabricId,
              closure: product.closure,
              basePrice: product.basePrice,
              isActive: true,
            },
            ACTOR_ID,
            tx,
          ),
        ).rejects.toThrow(/Mocca/);
      });
    });

    test("allows activating once every color with an active variant has a photo", async () => {
      await withRollback(async (tx) => {
        const fabric = await createFabricFixture(tx);
        const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
        const product = await createProductFixture(tx, fabric.id, { isActive: false });
        await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);
        await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

        const updated = await updateProduct(
          product.id,
          {
            name: product.name,
            slug: product.slug,
            fabricId: product.fabricId,
            closure: product.closure,
            basePrice: product.basePrice,
            isActive: true,
          },
          ACTOR_ID,
          tx,
        );
        expect(updated.isActive).toBe(true);
      });
    });

    test("allows activating when the color with no photo only has INACTIVE variants", async () => {
      await withRollback(async (tx) => {
        const fabric = await createFabricFixture(tx);
        const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
        const product = await createProductFixture(tx, fabric.id, { isActive: true }); // auto-inactive variant
        await addVariants({ productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] }, ACTOR_ID, tx);

        const updated = await updateProduct(
          product.id,
          {
            name: product.name,
            slug: product.slug,
            fabricId: product.fabricId,
            closure: product.closure,
            basePrice: product.basePrice,
            isActive: true,
          },
          ACTOR_ID,
          tx,
        );
        expect(updated.isActive).toBe(true);
      });
    });
  });
});

describe("setVariantActive — required-photo invariant", () => {
  test("refuses to activate a variant whose color has no photo", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const { created: [variant] } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );
      if (!variant) throw new Error("expected a variant to be created");
      await setVariantActive(variant.sku, false, ACTOR_ID, tx);

      await expect(setVariantActive(variant.sku, true, ACTOR_ID, tx)).rejects.toThrow(/Mocca/);
    });
  });

  test("allows activating a variant once its color has a photo", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id, { name: "Mocca" });
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const { created: [variant] } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );
      if (!variant) throw new Error("expected a variant to be created");
      await setVariantActive(variant.sku, false, ACTOR_ID, tx);
      await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      const after = await setVariantActive(variant.sku, true, ACTOR_ID, tx);
      expect(after.isActive).toBe(true);
    });
  });

  test("allows deactivating regardless of photos (the rule only guards activation)", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const color = await createFabricColorFixture(tx, fabric.id);
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const { created: [variant] } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: color.id, sizes: ["M"] }] },
        ACTOR_ID,
        tx,
      );
      if (!variant) throw new Error("expected a variant to be created");

      const after = await setVariantActive(variant.sku, false, ACTOR_ID, tx);
      expect(after.isActive).toBe(false);
    });
  });
});

describe("updateVariantsBulk", () => {
  test("updates every row and writes exactly ONE audit_log entry, not one per variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      // Inactive — this test is about updateVariantsBulk itself, not the required-photo rule
      // (addVariants would otherwise create these variants inactive on an active product whose
      // color has no photo yet).
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const { created } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: sage.id, sizes: ["S", "M", "L"] }] },
        ACTOR_ID,
        tx,
      );

      const updated = await updateVariantsBulk(
        {
          productId: product.id,
          updates: created.map((variant, index) => ({ sku: variant.sku, priceOverrideAmount: null, minStockQty: 5 + index })),
        },
        ACTOR_ID,
        tx,
      );
      expect(updated).toHaveLength(3);
      expect(updated.map((variant) => variant.minStockQty).sort()).toEqual([5, 6, 7]);

      const entries = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "product_variant"))
        .then((rows) => rows.filter((row) => row.entityId === product.id && row.action === "bulk_update"));
      expect(entries).toHaveLength(1);
      expect((entries[0]?.after as unknown[] | null)?.length).toBe(3);
    });
  });

  test("a failed row (SKU not found, or not belonging to this product) rolls back the entire batch (atomic)", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const sage = await createFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const product = await createProductFixture(tx, fabric.id, { isActive: false });
      const { created } = await addVariants(
        { productId: product.id, selections: [{ fabricColorId: sage.id, sizes: ["S", "M"] }] },
        ACTOR_ID,
        tx,
      );
      const [first] = created;
      if (!first) throw new Error("expected at least one variant");

      await expect(
        updateVariantsBulk(
          {
            productId: product.id,
            updates: [
              { sku: first.sku, priceOverrideAmount: null, minStockQty: 99 },
              { sku: "SKU-TIDAK-ADA", priceOverrideAmount: null, minStockQty: 5 },
            ],
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow();

      // The first row's update must NOT have been applied either — the whole call is one
      // transaction, so a failure on the second row undoes the first.
      const [reloaded] = await tx.select().from(productVariants).where(eq(productVariants.sku, first.sku)).limit(1);
      expect(reloaded?.minStockQty).not.toBe(99);
    });
  });
});

describe("listProducts pagination", () => {
  test("page 2 shows different products than page 1, with a correct total count", async () => {
    await withRollback(async (tx) => {
      const fabric = await createFabricFixture(tx);
      const prefix = `Zzz-Pagination-${randomUUID().slice(0, 6)}`;
      for (let i = 0; i < 21; i += 1) {
        await createProductFixture(tx, fabric.id, {
          name: `${prefix} ${String(i).padStart(2, "0")}`,
          slug: `${prefix.toLowerCase()}-${i}`,
          code: `${prefix.toUpperCase().replace(/[^A-Z0-9]/g, "")}${i}`,
        });
      }

      const page1 = await listProducts(prefix, "1", tx);
      const page2 = await listProducts(prefix, "2", tx);

      expect(page1.pagination.totalCount).toBe(21);
      expect(page1.pagination.totalPages).toBe(2);
      expect(page1.rows).toHaveLength(20);
      expect(page2.rows).toHaveLength(1);
      expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
    });
  });
});

describe("getCurrentCostAssumption", () => {
  test("returns the seeded cost_assumptions row for today", async () => {
    const row = await getCurrentCostAssumption(testDb);
    expect(row).not.toBeNull();
    expect(row?.marketplaceFeeBps).toBe(1800);
  });
});
