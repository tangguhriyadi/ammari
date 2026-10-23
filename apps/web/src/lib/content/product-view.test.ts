import { describe, expect, test } from "vitest";
import type { StorefrontProduct } from "@ammari/db/storefront";
import { buildProductView as buildProductViewPriced, getGalleryForColor, getPrimaryImage, resolveSelectedColorId } from "./product-view";

const PRICE = { listPrice: 269_000, unitPrice: 269_000, discounted: false, percentOff: null };

/** Most tests here are about images/sizes/colours, not price: build with a fixed normal price. */
function buildProductView(product: StorefrontProduct) {
  return buildProductViewPriced(product, PRICE);
}

function baseProduct(overrides: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: "product-1",
    name: "Gamis Flowy Straight",
    slug: "gamis-flowy-straight",
    pricing: { basePrice: 269_000, discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null },
    storefrontDescription: "<p>Deskripsi</p>",
    highlights: ["flowy", "breathable"],
    sizeMode: "sized",
    allsizeFitNote: null,
    careInstructions: "Cuci dengan air dingin",
    images: [],
    colors: [],
    variants: [],
    sizeChart: null,
    ...overrides,
  };
}

describe("buildProductView", () => {
  test("carries the price the page resolved for this request, not the raw pricing", () => {
    const sale = { listPrice: 350_000, unitPrice: 279_000, discounted: true, percentOff: 20 };
    expect(buildProductViewPriced(baseProduct(), sale).price).toEqual(sale);
  });

  test("orders highlights by the canonical key order, not the stored array order", () => {
    const view = buildProductView(baseProduct({ highlights: ["not_see_through", "breathable"] }));
    expect(view.highlights.map((h) => h.key)).toEqual(["breathable", "not_see_through"]);
  });

  test("groups images by colour, falling back general images for any colour", () => {
    const product = baseProduct({
      colors: [
        { id: "beige", name: "Beige", hex: "#E8DCD3" },
        { id: "navy", name: "Navy", hex: "#1B2436" },
      ],
      images: [
        { id: "img-general", storageKey: "general/1", fabricColorId: null, altText: "Umum", sortOrder: 0, width: 800, height: 1200 },
        { id: "img-beige", storageKey: "beige/1", fabricColorId: "beige", altText: "Beige 1", sortOrder: 0, width: 800, height: 1200 },
      ],
    });
    const view = buildProductView(product);

    // Beige has its own photo, THEN the general one appended.
    expect(getGalleryForColor(view, "beige").map((i) => i.id)).toEqual(["img-beige", "img-general"]);
    // Navy has no colour-specific photo — falls back to the general ones only.
    expect(getGalleryForColor(view, "navy").map((i) => i.id)).toEqual(["img-general"]);
  });

  test("a product with zero images of any kind gets an empty gallery (placeholder), never throws", () => {
    const product = baseProduct({ colors: [{ id: "beige", name: "Beige", hex: null }], images: [] });
    const view = buildProductView(product);
    expect(getGalleryForColor(view, "beige")).toEqual([]);
    expect(getPrimaryImage(view)).toBeNull();
  });

  test("a colour with no photo and no general photo falls back to the first other colour's photos", () => {
    const product = baseProduct({
      colors: [
        { id: "taupe", name: "Taupe", hex: null },
        { id: "beige", name: "Beige", hex: null },
        { id: "navy", name: "Navy", hex: null },
      ],
      images: [
        { id: "img-navy", storageKey: "navy/1", fabricColorId: "navy", altText: "Navy 1", sortOrder: 0, width: 800, height: 1200 },
        { id: "img-beige-2", storageKey: "beige/2", fabricColorId: "beige", altText: "Beige 2", sortOrder: 1, width: 800, height: 1200 },
        { id: "img-beige-1", storageKey: "beige/1", fabricColorId: "beige", altText: "Beige 1", sortOrder: 0, width: 800, height: 1200 },
      ],
    });
    const view = buildProductView(product);

    // Taupe has nothing: Beige comes first in canonical colour order, so its photos are used.
    expect(getGalleryForColor(view, "taupe").map((i) => i.id)).toEqual(["img-beige-1", "img-beige-2"]);
    // A colour WITH its own photos still only shows its own.
    expect(getGalleryForColor(view, "navy").map((i) => i.id)).toEqual(["img-navy"]);
    expect(getPrimaryImage(view)?.id).toBe("img-beige-1");
  });

  test("the primary image prefers a general photo over any colour's photo", () => {
    const product = baseProduct({
      colors: [{ id: "beige", name: "Beige", hex: null }],
      images: [
        { id: "img-beige", storageKey: "beige/1", fabricColorId: "beige", altText: null, sortOrder: 0, width: 800, height: 1200 },
        { id: "img-general", storageKey: "general/1", fabricColorId: null, altText: null, sortOrder: 0, width: 800, height: 1200 },
      ],
    });
    expect(getPrimaryImage(buildProductView(product))?.id).toBe("img-general");
  });

  test("sized product: only sizes with an active variant are offered, with stock decided per size", () => {
    const product = baseProduct({
      sizeMode: "sized",
      colors: [{ id: "beige", name: "Beige", hex: null }],
      variants: [
        { sku: "SKU-M", fabricColorId: "beige", size: "M", available: true },
        { sku: "SKU-S", fabricColorId: "beige", size: "S", available: false },
      ],
    });
    const view = buildProductView(product);
    // XS, L and XL have no active variant for this colour, so they are not offered at all.
    expect(view.sizeOptionsByColor?.beige).toEqual([
      { size: "S", sku: "SKU-S", available: false },
      { size: "M", sku: "SKU-M", available: true },
    ]);
    expect(view.allsizeAvailableByColor).toBeNull();
    expect(view.allsizeSkuByColor).toBeNull();
    expect(view.soldOut).toBe(false);
  });

  test("sizes follow the size chart's row order, then any other size canonically; recomputed per colour", () => {
    const product = baseProduct({
      colors: [
        { id: "beige", name: "Beige", hex: null },
        { id: "navy", name: "Navy", hex: null },
      ],
      sizeChart: [
        { size: "L", bustCm: 1, lengthCm: 1, sleeveLengthCm: 1, heightRecommendationMinCm: 1, heightRecommendationMaxCm: 1 },
        { size: "M", bustCm: 1, lengthCm: 1, sleeveLengthCm: 1, heightRecommendationMinCm: 1, heightRecommendationMaxCm: 1 },
      ],
      variants: [
        { sku: "B-M", fabricColorId: "beige", size: "M", available: true },
        { sku: "B-L", fabricColorId: "beige", size: "L", available: true },
        { sku: "B-XS", fabricColorId: "beige", size: "XS", available: true },
        { sku: "N-M", fabricColorId: "navy", size: "M", available: false },
      ],
    });
    const view = buildProductView(product);
    expect(view.sizeOptionsByColor?.beige?.map((o) => o.size)).toEqual(["L", "M", "XS"]);
    expect(view.sizeOptionsByColor?.navy).toEqual([{ size: "M", sku: "N-M", available: false }]);
  });

  test("soldOut is true only when no active variant of any colour has stock", () => {
    const colors = [{ id: "beige", name: "Beige", hex: null }];
    expect(buildProductView(baseProduct({ colors, variants: [{ sku: "A", fabricColorId: "beige", size: "M", available: false }] })).soldOut).toBe(true);
    expect(buildProductView(baseProduct({ colors, variants: [] })).soldOut).toBe(true);
    expect(buildProductView(baseProduct({ colors, variants: [{ sku: "A", fabricColorId: "beige", size: "M", available: true }] })).soldOut).toBe(false);
  });

  test("all_size product: no size options, just a per-colour ALLSIZE availability and SKU map", () => {
    const product = baseProduct({
      sizeMode: "all_size",
      colors: [{ id: "beige", name: "Beige", hex: null }],
      variants: [{ sku: "SKU-ALLSIZE", fabricColorId: "beige", size: "ALLSIZE", available: true }],
    });
    const view = buildProductView(product);
    expect(view.sizeOptionsByColor).toBeNull();
    expect(view.allsizeAvailableByColor).toEqual({ beige: true });
    expect(view.allsizeSkuByColor).toEqual({ beige: "SKU-ALLSIZE" });
  });

  test("defaultColorId is the first colour in canonical (already-ordered) order, null if there are none", () => {
    const withColors = buildProductView(baseProduct({ colors: [{ id: "a", name: "A", hex: null }, { id: "b", name: "B", hex: null }] }));
    expect(withColors.defaultColorId).toBe("a");

    const withoutColors = buildProductView(baseProduct({ colors: [] }));
    expect(withoutColors.defaultColorId).toBeNull();
  });
});

describe("resolveSelectedColorId", () => {
  const view = buildProductView(
    baseProduct({ colors: [{ id: "beige", name: "Beige", hex: null }, { id: "navy", name: "Navy", hex: null }] }),
  );

  test("uses the requested colour when it's one of the product's real colours", () => {
    expect(resolveSelectedColorId(view, "navy")).toBe("navy");
  });

  test("falls back to the default colour for an unknown/stale ?color= value", () => {
    expect(resolveSelectedColorId(view, "deactivated-color-id")).toBe("beige");
  });

  test("falls back to the default colour when no colour was requested", () => {
    expect(resolveSelectedColorId(view, null)).toBe("beige");
  });
});
