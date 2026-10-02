import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fabricColors, fabrics, products, productVariants } from "../src/schema";
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

// Each assertion below gets its OWN `withRollback` transaction — a failed statement aborts the
// rest of a Postgres transaction (25P02 "current transaction is aborted"), so a rejection
// assertion and a resolving assertion can never share one `tx`.

/** drizzle-orm wraps the driver error as "Failed query: ..." and puts the real Postgres message
 * (our RAISE EXCEPTION text, or a constraint name) on `.cause` — same unwrapping rbac.test.ts
 * uses. For a plain FK/unique violation (no custom message), the useful signal is `.code`. */
async function causeOf(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { message: String(cause), code: (cause as { code?: string } | undefined)?.code };
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("enforce_variant_size_mode trigger", () => {
  test("a 'sized' product rejects an ALLSIZE variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id, { sizeMode: "sized" });
      const { message } = await causeOf(
        tx.insert(productVariants).values({
          sku: `SKU-${randomUUID()}`,
          productId: product.id,
          fabricId: fabric.id,
          fabricColorId: color.id,
          closure: product.closure,
          size: "ALLSIZE",
        }),
      );
      expect(message).toMatch(/requires a sized variant/);
    });
  });

  test("an 'all_size' product rejects a sized (XS-XL) variant", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id, { sizeMode: "all_size" });
      const { message } = await causeOf(
        tx.insert(productVariants).values({
          sku: `SKU-${randomUUID()}`,
          productId: product.id,
          fabricId: fabric.id,
          fabricColorId: color.id,
          closure: product.closure,
          size: "M",
        }),
      );
      expect(message).toMatch(/requires an ALLSIZE variant/);
    });
  });
});

describe("a variant's color must belong to its own product's fabric", () => {
  test("rejects a fabric_color_id from a DIFFERENT fabric than the product's", async () => {
    await withRollback(async (tx) => {
      const fabricA = await insertFabricFixture(tx, { name: "Poka" });
      const fabricB = await insertFabricFixture(tx, { name: "Marina" });
      const colorFromB = await insertFabricColorFixture(tx, fabricB.id);
      const productOnA = await insertProductFixture(tx, fabricA.id);

      const { code } = await causeOf(
        tx.insert(productVariants).values({
          sku: `SKU-${randomUUID()}`,
          productId: productOnA.id,
          fabricId: fabricA.id, // the product's real fabric
          fabricColorId: colorFromB.id, // but a color that belongs to fabricB — mismatch
          closure: productOnA.closure,
          size: "M",
        }),
      );
      // 23503 = foreign_key_violation — the composite FK (fabric_color_id, fabric_id) ->
      // fabric_colors(id, fabric_id) has no matching row, since colorFromB's fabric_id is
      // fabricB.id, not fabricA.id.
      expect(code).toBe("23503");
    });
  });

  test("accepts a fabric_color_id that genuinely belongs to the product's fabric", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id);
      await expect(
        tx.insert(productVariants).values({
          sku: `SKU-${randomUUID()}`,
          productId: product.id,
          fabricId: fabric.id,
          fabricColorId: color.id,
          closure: product.closure,
          size: "M",
        }),
      ).resolves.not.toThrow();
    });
  });
});

describe("a product's fabric cannot change once it has a variant", () => {
  test("rejects UPDATE products SET fabric_id after a variant exists", async () => {
    await withRollback(async (tx) => {
      const oldFabric = await insertFabricFixture(tx, { name: "Poka" });
      const newFabric = await insertFabricFixture(tx, { name: "Marina" });
      const color = await insertFabricColorFixture(tx, oldFabric.id);
      const product = await insertProductFixture(tx, oldFabric.id);
      await tx.insert(productVariants).values({
        sku: `SKU-${randomUUID()}`,
        productId: product.id,
        fabricId: oldFabric.id,
        fabricColorId: color.id,
        closure: product.closure,
        size: "M",
      });

      const { code } = await causeOf(
        tx.update(products).set({ fabricId: newFabric.id }).where(eq(products.id, product.id)),
      );
      // 23503 again — ON UPDATE RESTRICT on products(id, fabric_id): the existing variant still
      // references the OLD (id, fabric_id) pair, so Postgres refuses to let it go stale.
      expect(code).toBe("23503");
    });
  });

  test("allows changing fabric_id while the product has no variants yet", async () => {
    await withRollback(async (tx) => {
      const oldFabric = await insertFabricFixture(tx, { name: "Poka" });
      const newFabric = await insertFabricFixture(tx, { name: "Marina" });
      const product = await insertProductFixture(tx, oldFabric.id);
      await expect(
        tx.update(products).set({ fabricId: newFabric.id }).where(eq(products.id, product.id)),
      ).resolves.not.toThrow();
    });
  });
});

describe("a product's closure cannot change once it has a variant", () => {
  test("rejects UPDATE products SET closure after a variant exists", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id, { closure: "front_zip" });
      await tx.insert(productVariants).values({
        sku: `SKU-${randomUUID()}`,
        productId: product.id,
        fabricId: fabric.id,
        fabricColorId: color.id,
        closure: "front_zip",
        size: "M",
      });

      const { code } = await causeOf(
        tx.update(products).set({ closure: "back_zip" }).where(eq(products.id, product.id)),
      );
      // 23503 — ON UPDATE RESTRICT on products(id, fabric_id, closure): the existing variant
      // still references the OLD (id, fabric_id, closure) triple, so Postgres refuses to let it
      // go stale, same mechanism as the fabric_id guarantee above.
      expect(code).toBe("23503");
    });
  });

  test("allows changing closure while the product has no variants yet", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const product = await insertProductFixture(tx, fabric.id, { closure: "front_zip" });
      await expect(
        tx.update(products).set({ closure: "back_zip" }).where(eq(products.id, product.id)),
      ).resolves.not.toThrow();
    });
  });
});

describe("fabric_colors.name uniqueness", () => {
  test("rejects a duplicate color name on the same fabric, case-insensitively", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      await insertFabricColorFixture(tx, fabric.id, { name: "Sage" });
      const { code } = await causeOf(tx.insert(fabricColors).values({ fabricId: fabric.id, name: "sage" }));
      expect(code).toBe("23505"); // unique_violation — citext makes "Sage"/"sage" collide.
    });
  });

  test("allows the same color name on a DIFFERENT fabric", async () => {
    await withRollback(async (tx) => {
      const fabricA = await insertFabricFixture(tx, { name: "Poka" });
      const fabricB = await insertFabricFixture(tx, { name: "Marina" });
      await insertFabricColorFixture(tx, fabricA.id, { name: "Sage" });
      await expect(tx.insert(fabricColors).values({ fabricId: fabricB.id, name: "Sage" })).resolves.not.toThrow();
    });
  });
});

describe("fabric_colors.hex", () => {
  test("rejects lowercase / missing '#' hex", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      await expect(
        tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Sage", hex: "9caf88" }),
      ).rejects.toThrow();
    });
  });

  test("accepts uppercase '#RRGGBB', and allows a null hex", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      await expect(
        tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Sage", hex: "#9CAF88" }),
      ).resolves.not.toThrow();
      await expect(tx.insert(fabricColors).values({ fabricId: fabric.id, name: "Mocca" })).resolves.not.toThrow();
    });
  });
});

describe("deleting a fabric color", () => {
  test("a color referenced by a variant cannot be deleted", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      const product = await insertProductFixture(tx, fabric.id);
      await tx.insert(productVariants).values({
        sku: `SKU-${randomUUID()}`,
        productId: product.id,
        fabricId: fabric.id,
        fabricColorId: color.id,
        closure: product.closure,
        size: "M",
      });
      const { code } = await causeOf(tx.delete(fabricColors).where(eq(fabricColors.id, color.id)));
      expect(code).toBe("23503");
    });
  });

  test("an unused color can be deleted", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const color = await insertFabricColorFixture(tx, fabric.id);
      await expect(tx.delete(fabricColors).where(eq(fabricColors.id, color.id))).resolves.not.toThrow();
    });
  });
});
