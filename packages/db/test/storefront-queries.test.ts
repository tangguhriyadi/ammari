import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  costComponents,
  fabricColors,
  fabrics,
  infoPages,
  productImages,
  products,
  productionBatchCosts,
  productionBatchItems,
  productionBatches,
  productVariants,
  sizeChartRows,
  sizeCharts,
  stockMovements,
  storefrontHomepageSections,
  storeSettings,
} from "../src/schema";
import {
  getDraftHomepageContent,
  getPublishedHomepageContent,
  getPublishedInfoPage,
  getStorefrontProductBySlug,
  getStoreSettings,
} from "../src/storefront/queries";
import { insertStaffUser } from "./fixtures";
import { withRollback, type TestTx } from "./helpers";

// A denylist of substrings that must NEVER appear anywhere in the storefront read layer's
// serialized output — a structural guard, not just a behavioral one: if a future change widens
// a `.select()` in storefront/queries.ts, this test fails even if nobody thought to ask "did I
// just leak cost data."
const COST_LEAK_DENYLIST = ["cost", "hpp", "margin", "supplier", "priceAmount", "valueAmount", "unitCost", "minStock"];

async function seedFullProductFixture(tx: TestTx) {
  const internalDescription = `INTERNAL_MARKER_${randomUUID()}`;
  const storefrontDescriptionValue = `PUBLIC_MARKER_${randomUUID()}`;

  const [fabric] = await tx
    .insert(fabrics)
    .values({
      name: `Katun Rayon ${randomUUID().slice(0, 8)}`,
      priceAmount: 48_000,
      priceUnit: "meter",
      supplier: "Toko Kain Pasar Baru",
      careInstructions: "Cuci dengan air dingin, jangan diperas",
    })
    .returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");

  const [color] = await tx
    .insert(fabricColors)
    .values({ fabricId: fabric.id, name: `Sage ${randomUUID().slice(0, 8)}`, hex: "#A3B18A" })
    .returning();
  if (!color) throw new Error("failed to insert fabric color fixture");

  const [chart] = await tx.insert(sizeCharts).values({ name: "Gamis Reguler" }).returning();
  if (!chart) throw new Error("failed to insert size chart fixture");
  await tx.insert(sizeChartRows).values({
    sizeChartId: chart.id,
    size: "M",
    bustCm: 100,
    lengthCm: 140,
    sleeveLengthCm: 55,
    heightRecommendationMinCm: 155,
    heightRecommendationMaxCm: 165,
  });

  const slug = `gamis-storefront-${randomUUID()}`;
  const [product] = await tx
    .insert(products)
    .values({
      name: `Gamis Storefront Test ${randomUUID().slice(0, 8)}`,
      code: `STF${randomUUID().slice(0, 8).toUpperCase()}`,
      slug,
      description: internalDescription,
      storefrontDescription: storefrontDescriptionValue,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 259_000,
      isActive: true,
      isPublishedOnStorefront: true,
      highlights: ["flowy"],
      sizeChartId: chart.id,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");

  const [imageGeneral] = await tx
    .insert(productImages)
    .values({
      productId: product.id,
      fabricId: fabric.id,
      storageKey: `content/${product.id}/general.webp`,
      width: 800,
      height: 1200,
      altText: "Gamis tampak depan",
      sortOrder: 0,
    })
    .returning();
  if (!imageGeneral) throw new Error("failed to insert product image fixture");

  const [variantAvailable] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: color.id,
      closure: product.closure,
      size: "M",
      priceOverrideAmount: 999_999, // never read by the storefront — see the price test below
      isActive: true,
    })
    .returning();
  if (!variantAvailable) throw new Error("failed to insert variant fixture");

  const [variantOutOfStock] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: color.id,
      closure: product.closure,
      size: "S",
      isActive: true,
    })
    .returning();
  if (!variantOutOfStock) throw new Error("failed to insert variant fixture");

  const [variantInactive] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: color.id,
      closure: product.closure,
      size: "L",
      isActive: false,
    })
    .returning();
  if (!variantInactive) throw new Error("failed to insert variant fixture");

  // Stock: variantAvailable has net positive stock; variantOutOfStock nets to zero;
  // variantInactive has stock too, but must never show up at all (filtered by is_active).
  await tx.insert(stockMovements).values([
    { sku: variantAvailable.sku, qty: 10, valueAmount: 480_000, type: "production", refType: "manual" },
    { sku: variantOutOfStock.sku, qty: 5, valueAmount: 240_000, type: "production", refType: "manual" },
    { sku: variantOutOfStock.sku, qty: -5, valueAmount: -240_000, type: "sale", refType: "manual" },
    { sku: variantInactive.sku, qty: 3, valueAmount: 144_000, type: "production", refType: "manual" },
  ]);

  // A production batch with real costs attached to this exact fabric/SKU — the cost-leak test's
  // whole point is that none of this ever reaches the storefront output, even though it sits
  // right next to the product's own data. Items/costs must be inserted BEFORE posting — a
  // posted batch's lines are immutable (prevent_posted_batch_items_mutation, migration 0007).
  const staffUser = await insertStaffUser(tx, "owner");
  const [batch] = await tx
    .insert(productionBatches)
    .values({
      fabricId: fabric.id,
      batchNo: `BATCH-TEST-${randomUUID().slice(0, 8)}`,
      producedAt: "2026-10-01",
      fabricYards: 20,
      fabricCostAmount: 960_000,
    })
    .returning();
  if (!batch) throw new Error("failed to insert production batch fixture");

  await tx.insert(productionBatchItems).values({
    productionBatchId: batch.id,
    fabricId: fabric.id,
    sku: variantAvailable.sku,
    qty: 10,
    unitCostAmount: 72_000,
  });

  const [costComponent] = await tx
    .insert(costComponents)
    .values({ name: `Ongkos Jahit ${randomUUID().slice(0, 8)}`, unit: "pcs", defaultUnitPrice: 15_000 })
    .returning();
  if (!costComponent) throw new Error("failed to insert cost component fixture");

  await tx.insert(productionBatchCosts).values({
    productionBatchId: batch.id,
    costComponentId: costComponent.id,
    componentName: costComponent.name,
    componentUnit: costComponent.unit,
    costType: "variable",
    quantity: 10,
    unitPrice: 15_000,
  });

  await tx
    .update(productionBatches)
    .set({ status: "posted", postedAt: new Date(), postedByStaffUserId: staffUser.id })
    .where(eq(productionBatches.id, batch.id));

  return {
    product,
    slug,
    internalDescription,
    storefrontDescriptionValue,
    variantAvailable,
    variantOutOfStock,
    variantInactive,
    color,
    chart,
  };
}

describe("getStorefrontProductBySlug", () => {
  test("never leaks cost/margin/supplier/price-override data, and keeps description distinct from storefrontDescription", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedFullProductFixture(tx);
      const result = await getStorefrontProductBySlug(fixture.slug, tx);
      expect(result).not.toBeNull();

      const serialized = JSON.stringify(result);
      for (const term of COST_LEAK_DENYLIST) {
        expect(serialized).not.toContain(term);
      }

      expect(serialized).not.toContain(fixture.internalDescription);
      expect(serialized).toContain(fixture.storefrontDescriptionValue);
      expect(result?.storefrontDescription).toBe(fixture.storefrontDescriptionValue);
    });
  });

  test("price is always the product's own basePrice, never a variant's priceOverrideAmount", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedFullProductFixture(tx);
      const result = await getStorefrontProductBySlug(fixture.slug, tx);
      expect(result?.basePrice).toBe(fixture.product.basePrice);
      expect(JSON.stringify(result)).not.toContain("999999");
    });
  });

  test("availability: in-stock, zero-net-stock, and a deactivated variant", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedFullProductFixture(tx);
      const result = await getStorefrontProductBySlug(fixture.slug, tx);
      expect(result).not.toBeNull();

      const bySku = new Map(result?.variants.map((v) => [v.sku, v]));
      expect(bySku.get(fixture.variantAvailable.sku)?.available).toBe(true);
      expect(bySku.get(fixture.variantOutOfStock.sku)?.available).toBe(false);
      // The inactive variant has real stock on the ledger but must never appear at all.
      expect(bySku.has(fixture.variantInactive.sku)).toBe(false);
    });
  });

  test("returns the assigned size chart's rows", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedFullProductFixture(tx);
      const result = await getStorefrontProductBySlug(fixture.slug, tx);
      expect(result?.sizeChart).toEqual([
        {
          size: "M",
          bustCm: 100,
          lengthCm: 140,
          sleeveLengthCm: 55,
          heightRecommendationMinCm: 155,
          heightRecommendationMaxCm: 165,
        },
      ]);
    });
  });

  test("returns null for an inactive product", async () => {
    await withRollback(async (tx) => {
      const fixture = await seedFullProductFixture(tx);
      await tx
        .update(products)
        .set({ isActive: false, isPublishedOnStorefront: false })
        .where(eq(products.id, fixture.product.id));
      const result = await getStorefrontProductBySlug(fixture.slug, tx);
      expect(result).toBeNull();
    });
  });

  test("returns null for an active-but-unpublished product", async () => {
    await withRollback(async (tx) => {
      const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon" }).returning();
      if (!fabric) throw new Error("failed to insert fabric fixture");
      const slug = `gamis-unpublished-${randomUUID()}`;
      await tx.insert(products).values({
        name: "Gamis Belum Terbit",
        code: `UNP${randomUUID().slice(0, 8).toUpperCase()}`,
        slug,
        fabricId: fabric.id,
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: 199_000,
        isActive: true,
        isPublishedOnStorefront: false,
      });
      const result = await getStorefrontProductBySlug(slug, tx);
      expect(result).toBeNull();
    });
  });

  test("returns null for a slug that doesn't exist", async () => {
    await withRollback(async (tx) => {
      const result = await getStorefrontProductBySlug(`nonexistent-${randomUUID()}`, tx);
      expect(result).toBeNull();
    });
  });
});

describe("getPublishedHomepageContent / getDraftHomepageContent", () => {
  test("a published row shows up in the published read but not vice versa for an unpublished one", async () => {
    await withRollback(async (tx) => {
      const staffUser = await insertStaffUser(tx, "owner");
      const draftPayload = { headline: `draft-only-${randomUUID()}` };
      const publishedPayload = { headline: `published-${randomUUID()}` };

      await tx
        .update(storefrontHomepageSections)
        .set({ draftContent: draftPayload })
        .where(eq(storefrontHomepageSections.key, "hero"));
      await tx
        .update(storefrontHomepageSections)
        .set({
          publishedContent: publishedPayload,
          publishedIsVisible: true,
          publishedAt: new Date(),
          publishedByStaffUserId: staffUser.id,
        })
        .where(eq(storefrontHomepageSections.key, "product_grid"));

      const published = await getPublishedHomepageContent(tx);
      const draft = await getDraftHomepageContent(tx);

      const publishedHero = published.find((s) => s.key === "hero");
      const publishedGrid = published.find((s) => s.key === "product_grid");
      const draftHero = draft.find((s) => s.key === "hero");

      // hero was never published — the published read must not see its draft content.
      expect(publishedHero?.content).toBeNull();
      expect(publishedHero?.isVisible).toBe(false);
      // product_grid WAS published — the published read sees exactly that content.
      expect(publishedGrid?.content).toEqual(publishedPayload);
      expect(publishedGrid?.isVisible).toBe(true);
      // the draft read sees hero's draft regardless of publish state.
      expect(draftHero?.content).toEqual(draftPayload);

      expect(published.map((s) => s.key)).toEqual(draft.map((s) => s.key));
    });
  });
});

describe("getPublishedInfoPage", () => {
  test("returns the published body/title, never the draft one", async () => {
    await withRollback(async (tx) => {
      const draftOnly = `draft-only-${randomUUID()}`;
      const published = `<p>published-${randomUUID()}</p>`;
      await tx
        .update(infoPages)
        .set({ draftBody: draftOnly, publishedBody: published, title: "Cara Pemesanan", publishedAt: new Date() })
        .where(eq(infoPages.slug, "how-to-order"));

      const result = await getPublishedInfoPage("how-to-order", tx);
      expect(result).not.toBeNull();
      expect(result?.body).toBe(published);
      expect(result?.body).not.toContain(draftOnly);
      expect(result?.title).toBe("Cara Pemesanan");
    });
  });

  test("returns null for a slug that has never been published (published_body still null)", async () => {
    await withRollback(async (tx) => {
      // migration 0020 seeds returns-exchange/how-to-order/shipping with a null published_body —
      // nothing to update here, this asserts the seeded state itself resolves to null.
      const result = await getPublishedInfoPage("shipping", tx);
      expect(result).toBeNull();
    });
  });

  test("returns null for an unknown slug — never throws", async () => {
    await withRollback(async (tx) => {
      const result = await getPublishedInfoPage("not-a-real-slug", tx);
      expect(result).toBeNull();
    });
  });
});

describe("getStoreSettings", () => {
  test("returns every field once saved", async () => {
    await withRollback(async (tx) => {
      await tx
        .update(storeSettings)
        .set({
          whatsappNumber: "6281234567890",
          supportEmail: "halo@ammari.id",
          businessAddress: "Jl. Contoh No. 1",
          returnPolicySummary: "Tukar ukuran dalam 3 hari",
        })
        .where(eq(storeSettings.id, 1));

      const result = await getStoreSettings(tx);
      expect(result).toEqual({
        whatsappNumber: "6281234567890",
        supportEmail: "halo@ammari.id",
        businessAddress: "Jl. Contoh No. 1",
        returnPolicySummary: "Tukar ukuran dalam 3 hari",
      });
    });
  });

  test("every field is null before the owner fills anything in — never throws, never a missing row", async () => {
    await withRollback(async (tx) => {
      const result = await getStoreSettings(tx);
      expect(result).toEqual({
        whatsappNumber: null,
        supportEmail: null,
        businessAddress: null,
        returnPolicySummary: null,
      });
    });
  });
});
