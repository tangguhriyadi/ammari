import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import sharp from "sharp";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { insertProductVariant, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { productImages, products } from "@ammari/db/schema";
import { MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH } from "@ammari/content-sanitize";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import { ActionError } from "@/lib/errors";
import { createSizeChart, type SizeChartRowInput } from "@/lib/content/size-charts";
import { CUTTING_SIZES, type CuttingSize } from "@ammari/db/schema";
import { uploadProductImage } from "./image-queries";
import { PUBLISH_ALT_TEXT_MESSAGE, PUBLISH_REQUIRES_PHOTO_MESSAGE } from "./photo-messages";
import { PUBLISH_REQUIRES_SHIPPING_WEIGHT_MESSAGE } from "./shipping-weight";
import { updateProductStorefront } from "./storefront";

const ACTOR_ID = null;

beforeEach(() => {
  __setStorageClientForTests(new InMemoryStorageClient());
});
afterEach(() => {
  __setStorageClientForTests(undefined);
});

async function setShippingWeight(tx: TestTx, productId: string, grams: number | null): Promise<void> {
  await tx.update(products).set({ shippingWeightGrams: grams }).where(eq(products.id, productId));
}

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

  test("rejects publishing a product with no photo at all, with a field error on the toggle", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const chart = await createSizeChart({ name: "Chart", rows: fullSizeChartRows() }, ACTOR_ID, tx);

      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chart.id },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "isPublishedOnStorefront", message: PUBLISH_REQUIRES_PHOTO_MESSAGE });
    });
  });

  test("one general photo is enough to publish, even when a color has no photo of its own", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await setShippingWeight(tx, product.id, 800);
      const chart = await createSizeChart({ name: "Chart", rows: fullSizeChartRows() }, ACTOR_ID, tx);
      await uploadProductImage({ productId: product.id, fabricColorId: null, altText: "Gamis tampak depan", fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);

      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chart.id },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(true);
    });
  });

  test("a photo whose alt text is empty (e.g. written by the previous release) gets the default at publish instead of blocking it", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      await setShippingWeight(tx, product.id, 800);
      const chart = await createSizeChart({ name: "Chart", rows: fullSizeChartRows() }, ACTOR_ID, tx);
      const image = await uploadProductImage({ productId: product.id, fabricColorId: color.id, fileBuffer: await jpegBuffer() }, ACTOR_ID, tx);
      await tx.update(productImages).set({ altText: null }).where(eq(productImages.id, image.id));

      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chart.id },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(true);
      const [filled] = await tx.select().from(productImages).where(eq(productImages.id, image.id));
      expect(filled?.altText).toBe(`${product.name} warna ${color.name}`);
    });
  });

  test("the photo-related publish messages name the Foto section, never a position on the page", () => {
    for (const message of [PUBLISH_REQUIRES_PHOTO_MESSAGE, PUBLISH_ALT_TEXT_MESSAGE]) {
      expect(message).toContain("bagian Foto");
      expect(message).not.toMatch(/di (bawah|atas)/i);
    }
  });

  test("publishes successfully once active, size-charted, weighed, and every image has alt text", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      await setShippingWeight(tx, product.id, 800);
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
      await setShippingWeight(tx, product.id, 700);
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

describe("updateProductStorefront — shipping weight (docs/plans/cart-checkout.md §4.5.3)", () => {
  /** Active, size-charted, one photo with alt text: everything publishing needs except a weight. */
  async function photoReadyProduct(tx: TestTx) {
    const { product, color } = await insertProductVariant(tx);
    const chart = await createSizeChart({ name: `Chart ${product.id}`, rows: fullSizeChartRows() }, ACTOR_ID, tx);
    await uploadProductImage(
      { productId: product.id, fabricColorId: color.id, altText: "Gamis warna hitam tampak depan", fileBuffer: await jpegBuffer() },
      ACTOR_ID,
      tx,
    );
    return { product, chartId: chart.id };
  }

  test("going from hidden to published needs a weight, with a field error on the toggle", async () => {
    await withRollback(async (tx) => {
      const { product, chartId } = await photoReadyProduct(tx);
      await expect(
        updateProductStorefront(
          product.id,
          { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chartId },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toMatchObject({ field: "isPublishedOnStorefront", message: PUBLISH_REQUIRES_SHIPPING_WEIGHT_MESSAGE });
      const [unchanged] = await tx.select().from(products).where(eq(products.id, product.id));
      expect(unchanged?.isPublishedOnStorefront).toBe(false);

      await setShippingWeight(tx, product.id, 800);
      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: true, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chartId },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(true);
    });
  });

  test("a product published before the rule (no weight) stays published and can still be saved", async () => {
    await withRollback(async (tx) => {
      const { product, chartId } = await photoReadyProduct(tx);
      await tx.update(products).set({ isPublishedOnStorefront: true, sizeChartId: chartId }).where(eq(products.id, product.id));

      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: true, storefrontDescriptionHtml: "<p>Deskripsi baru</p>", allsizeFitNote: null, sizeChartId: chartId },
        ACTOR_ID,
        tx,
      );
      expect(after).toMatchObject({ isPublishedOnStorefront: true, shippingWeightGrams: null, storefrontDescription: "<p>Deskripsi baru</p>" });
    });
  });

  test("hiding a product never needs a weight", async () => {
    await withRollback(async (tx) => {
      const { product, chartId } = await photoReadyProduct(tx);
      await tx.update(products).set({ isPublishedOnStorefront: true, sizeChartId: chartId }).where(eq(products.id, product.id));
      const after = await updateProductStorefront(
        product.id,
        { isPublishedOnStorefront: false, storefrontDescriptionHtml: null, allsizeFitNote: null, sizeChartId: chartId },
        ACTOR_ID,
        tx,
      );
      expect(after.isPublishedOnStorefront).toBe(false);
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
