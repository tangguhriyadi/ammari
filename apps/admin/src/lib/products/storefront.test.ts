import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import sharp from "sharp";
import { withRollback } from "@ammari/db/test-utils";
import { insertProductVariant, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { products } from "@ammari/db/schema";
import { MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH } from "@ammari/content-sanitize";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import { ActionError } from "@/lib/errors";
import { createSizeChart, type SizeChartRowInput } from "@/lib/content/size-charts";
import { CUTTING_SIZES, type CuttingSize } from "@ammari/db/schema";
import { uploadProductImage } from "./image-queries";
import { updateProductStorefront } from "./storefront";

const ACTOR_ID = null;

beforeEach(() => {
  __setStorageClientForTests(new InMemoryStorageClient());
});
afterEach(() => {
  __setStorageClientForTests(undefined);
});

async function jpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
}

function fullSizeChartRows(): SizeChartRowInput[] {
  return CUTTING_SIZES.map((size: CuttingSize, index) => ({
    size,
    bustCm: 90 + index,
    lengthCm: 130 + index,
    sleeveLengthCm: 55 + index,
    heightRecommendationMinCm: 150 + index,
    heightRecommendationMaxCm: 160 + index,
  }));
}

describe("updateProductStorefront — publish-time guards", () => {
  test("rejects publishing an inactive product, with a field error on the toggle", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await tx.update(products).set({ isActive: false }).where(eq(products.id, product.id));

      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: null },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "isPublishedOnStorefront" });
    });
  });

  test("rejects publishing a 'sized' product with no size chart assigned", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx); // sizeMode: "sized" (fixture default)

      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: null },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "sizeChartId" });
    });
  });

  test("rejects publishing when a product image is missing alt text", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      const chart = await createSizeChart({ name: "Chart", rows: fullSizeChartRows() }, ACTOR_ID, tx);
      await uploadProductImage({ productId: product.id, fabricColorId: color.id, altText: null, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chart.id },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(ActionError);
    });
  });

  test("publishes successfully once active, size-charted, and every image has alt text", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      const chart = await createSizeChart({ name: "Chart", rows: fullSizeChartRows() }, ACTOR_ID, tx);
      await uploadProductImage(
        { productId: product.id, fabricColorId: color.id, altText: "Gamis warna hitam tampak depan", fileBuffer: await jpegBuffer() },
        ACTOR_ID,
        tx,
      );

      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: true, storefrontDescriptionHtml: "<p>Deskripsi</p>", allsizeFitNote: null, sizeChartId: chart.id },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(true);
      expect(after.storefrontDescription).toBe("<p>Deskripsi</p>");
      expect(after.sizeChartId).toBe(chart.id);
    });
  });

  test("an all_size product never needs a size chart to publish", async () => {
    await withRollback(async (tx) => {
      const { fabric, color } = await insertProductVariant(tx);
      const { product } = await insertVariantForProduct(tx, fabric.id, color.id, { sizeMode: "all_size" }, "ALLSIZE");
      await uploadProductImage(
        { productId: product.id, fabricColorId: color.id, altText: "Gamis All Size tampak depan", fileBuffer: await jpegBuffer() },
        ACTOR_ID,
        tx,
      );

      const after = await updateProductStorefront(
        product.id,
        {
          isPublishedOnStorefront: true,
          storefrontDescriptionHtml: null,
          allsizeFitNote: "Cocok untuk tinggi 150-165 cm.",
          sizeChartId: null,
        },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(true);
      expect(after.allsizeFitNote).toBe("Cocok untuk tinggi 150-165 cm.");
    });
  });

  test("a nonexistent size chart id surfaces as a friendly field error, not a raw FK violation", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await expect(
        updateProductStorefront(
          product.id,
          {
            isPublishedOnStorefront: false,
            storefrontDescriptionHtml: null,
            allsizeFitNote: null,
            sizeChartId: "00000000-0000-0000-0000-000000000000",
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "sizeChartId" });
    });
  });

  test("a nonexistent product id is rejected cleanly", async () => {
    await withRollback(async (tx) => {
      await expect(
        updateProductStorefront(
          "00000000-0000-0000-0000-000000000000",
          { isPublishedOnStorefront: false, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: null },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(ActionError);
    });
  });
});

describe("updateProductStorefront — description sanitization", () => {
  test("strips a malicious script tag before storing, keeping the allowed formatting", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const after = await updateProductStorefront(
        product.id,
        {
          isPublishedOnStorefront: false,
          storefrontDescriptionHtml: "<p>Gamis <strong>syar'i</strong></p><script>alert(document.cookie)</script>",
          allsizeFitNote: null,
          sizeChartId: null,
        },
        ACTOR_ID,
        tx,
      );
      expect(after.storefrontDescription).toBe("<p>Gamis <strong>syar'i</strong></p>");
      expect(after.storefrontDescription).not.toMatch(/script/i);
    });
  });

  test("strips event-handler attributes and javascript: links from the saved description", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const after = await updateProductStorefront(
        product.id,
        {
          isPublishedOnStorefront: false,
          storefrontDescriptionHtml: '<p onclick="evil()"><a href="javascript:alert(1)">Klik</a></p>',
          allsizeFitNote: null,
          sizeChartId: null,
        },
        ACTOR_ID,
        tx,
      );
      expect(after.storefrontDescription).toBe("<p>Klik</p>");
    });
  });

  test("an empty editor document is stored as null, not a literal empty paragraph", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: false, storefrontDescriptionHtml: "<p></p>", allsizeFitNote: null, sizeChartId: null },
        ACTOR_ID,
        tx,
      );
      expect(after.storefrontDescription).toBeNull();
    });
  });

  test("an oversized description is rejected as a field error, not thrown raw from the sanitizer", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const oversized = `<p>${"a".repeat(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH + 1)}</p>`;
      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: false, storefrontDescriptionHtml: oversized, allsizeFitNote: null, sizeChartId: null },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "storefrontDescriptionHtml" });
    });
  });
});
