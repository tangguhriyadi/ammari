import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertProductVariant, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { productVariants } from "@ammari/db/schema";

const { revalidateProductSlugsMock } = vi.hoisted(() => ({ revalidateProductSlugsMock: vi.fn() }));
vi.mock("@/lib/revalidate", () => ({ revalidateProductSlugs: revalidateProductSlugsMock }));

const { revalidateStorefrontForSkus } = await import("./storefront-stock");

afterEach(() => {
  revalidateProductSlugsMock.mockReset();
  vi.restoreAllMocks();
});

describe("revalidateStorefrontForSkus", () => {
  test("resolves SKUs to ONE deduplicated slug per product and revalidates them in a single call", async () => {
    revalidateProductSlugsMock.mockResolvedValue({ ok: true });
    await withRollback(async (tx) => {
      const { fabric, color, product, variant } = await insertProductVariant(tx);
      // A second SKU of the SAME product, and a SKU of another product.
      const [secondSize] = await tx
        .insert(productVariants)
        .values({ sku: `SKU-${randomUUID()}`, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure, size: "L" })
        .returning();
      const other = await insertVariantForProduct(tx, fabric.id, color.id);

      const result = await revalidateStorefrontForSkus([variant.sku, secondSize!.sku, other.variant.sku, variant.sku], tx);

      expect(result).toEqual({ ok: true });
      expect(revalidateProductSlugsMock).toHaveBeenCalledTimes(1);
      const slugs = revalidateProductSlugsMock.mock.calls[0]![0] as string[];
      // (revalidateProductSlugs itself deduplicates; the helper passes every resolved product slug.)
      expect(new Set(slugs)).toEqual(new Set([product.slug, other.product.slug]));
    });
  });

  test("makes no call for an empty or unknown SKU list", async () => {
    await withRollback(async (tx) => {
      expect(await revalidateStorefrontForSkus([], tx)).toEqual({ ok: true });
      await revalidateStorefrontForSkus(["NO-SUCH-SKU"], tx);
    });
    expect(revalidateProductSlugsMock).toHaveBeenCalledTimes(1);
    expect(revalidateProductSlugsMock).toHaveBeenCalledWith([]);
  });

  test("a SKU lookup passed as a function is inside the guard: when it throws, ok:false and no throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await revalidateStorefrontForSkus(async () => { throw new Error("db blip"); })).toEqual({ ok: false });
    expect(revalidateProductSlugsMock).not.toHaveBeenCalled();
  });

  test("reports ok:false and never throws when the storefront call fails or rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      revalidateProductSlugsMock.mockResolvedValueOnce({ ok: false });
      expect(await revalidateStorefrontForSkus([variant.sku], tx)).toEqual({ ok: false });
      revalidateProductSlugsMock.mockRejectedValueOnce(new Error("boom"));
      expect(await revalidateStorefrontForSkus([variant.sku], tx)).toEqual({ ok: false });
    });
  });
});
