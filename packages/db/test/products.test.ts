import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { fabrics, products } from "../src/schema";
import { PRODUCT_HIGHLIGHT_KEYS } from "../src/schema/constants";
import { withRollback, type TestTx } from "./helpers";

async function insertFabricFixture(tx: TestTx, overrides: Partial<typeof fabrics.$inferInsert> = {}) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon", ...overrides }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

function productValues(fabricId: string, overrides: Partial<typeof products.$inferInsert> = {}) {
  return {
    name: "Gamis Test",
    code: `CODE${randomUUID().slice(0, 8).toUpperCase()}`,
    slug: `gamis-test-${randomUUID()}`,
    fabricId,
    closure: "front_zip" as const,
    sizeMode: "sized" as const,
    basePrice: 259_000,
    ...overrides,
  };
}

/** Same unwrapping other packages/db tests use — drizzle-orm wraps the driver error and puts the
 * real Postgres code on `.cause`. */
async function causeCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return (cause as { code?: string } | undefined)?.code;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("products.highlights", () => {
  test("defaults to an empty array for a product inserted without it", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const [product] = await tx.insert(products).values(productValues(fabric.id)).returning();
      expect(product?.highlights).toEqual([]);
    });
  });

  test("stores all 5 allowed keys, in whatever order they're given", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const highlights = [...PRODUCT_HIGHLIGHT_KEYS];
      const [product] = await tx.insert(products).values(productValues(fabric.id, { highlights })).returning();
      expect(product?.highlights).toEqual(highlights);
    });
  });

  // Not free text (owner requirement) — the storefront maps each key to its own icon, which
  // only works for a closed set. `products_highlights_allowed_check` (<@ the 5 allowed keys).
  test("rejects a key outside the fixed set (products_highlights_allowed_check)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const code = await causeCode(
        tx.insert(products).values(productValues(fabric.id, { highlights: ["breathable", "bogus_key"] })),
      );
      expect(code).toBe("23514"); // check_violation
    });
  });

  // Also rejects the OLD free-text labels directly — confirms this isn't just "any 5-char
  // string passes," the actual stored values from before this requirement changed are
  // themselves now invalid.
  test("rejects the old free-text labels (no longer valid keys)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const code = await causeCode(
        tx.insert(products).values(productValues(fabric.id, { highlights: ["Breathable", "Flowy"] })),
      );
      expect(code).toBe("23514");
    });
  });

  // `products_highlights_no_duplicates_check` — backed by the hand-authored
  // text_array_has_duplicates() SQL function (migration 0018; Postgres rejects a subquery
  // directly inside a CHECK expression, confirmed empirically, so this couldn't be a plain
  // CHECK clause on its own).
  test("rejects a duplicate key (products_highlights_no_duplicates_check)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const code = await causeCode(
        tx.insert(products).values(productValues(fabric.id, { highlights: ["breathable", "breathable"] })),
      );
      expect(code).toBe("23514");
    });
  });

  // With only 5 valid keys total, 6 elements can never be achieved without either an invalid
  // key or a duplicate — `products_highlights_max_check` is now logically implied by the other
  // two, but kept as a cheap, explicit, self-documenting invariant (see catalog.ts's own
  // comment); this just confirms 6 elements are rejected regardless of which specific
  // constraint fires first.
  test("rejects 6 elements, which cannot happen without a duplicate or an invalid key", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const sixItems = [...PRODUCT_HIGHLIGHT_KEYS, "breathable"];
      const code = await causeCode(tx.insert(products).values(productValues(fabric.id, { highlights: sixItems })));
      expect(code).toBe("23514");
    });
  });
});

// getActiveProductBySlug (the old placeholder read, a bare `.select()`) is deleted — replaced by
// packages/db/src/storefront/queries.ts's getStorefrontProductBySlug, covered by
// test/storefront-queries.test.ts.

describe("products.is_published_on_storefront", () => {
  test("defaults to false", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const [product] = await tx.insert(products).values(productValues(fabric.id)).returning();
      expect(product?.isPublishedOnStorefront).toBe(false);
    });
  });

  // products_is_published_on_storefront_active_check — can't publish an inactive product
  // (migration 0019).
  test("rejects publishing an inactive product (products_is_published_on_storefront_active_check)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const code = await causeCode(
        tx.insert(products).values(productValues(fabric.id, { isActive: false, isPublishedOnStorefront: true })),
      );
      expect(code).toBe("23514");
    });
  });

  test("allows publishing an active product", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      await expect(
        tx.insert(products).values(productValues(fabric.id, { isActive: true, isPublishedOnStorefront: true })),
      ).resolves.not.toThrow();
    });
  });
});
