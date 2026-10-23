import { describe, expect, test } from "vitest";
import type { StorefrontProduct } from "@ammari/db/storefront";
import {
  buildProductGallery,
  buildProductView as buildProductViewPriced,
  getPrimaryImage,
  initialGalleryIndex,
  resolveSelectedColorId,
} from "./product-view";

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

  test("groups images by colour and keeps general images apart", () => {
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

    expect(view.generalImages.map((i) => i.id)).toEqual(["img-general"]);
    expect(view.imagesByColor.beige?.map((i) => i.id)).toEqual(["img-beige"]);
    // Navy has no colour-specific photo: no group at all.
    expect(view.imagesByColor.navy).toBeUndefined();
  });

  test("a product with zero images of any kind gets an empty gallery (placeholder), never throws", () => {
    const product = baseProduct({ colors: [{ id: "beige", name: "Beige", hex: null }], images: [] });
    const view = buildProductView(product);
    expect(buildProductGallery(view).images).toEqual([]);
    expect(getPrimaryImage(view)).toBeNull();
  });

  test("the primary image falls back to the first colour (swatch order) with photos", () => {
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

    // Taupe has nothing: Beige comes first in swatch order.
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

describe("buildProductGallery", () => {
  type Image = StorefrontProduct["images"][number];
  const image = (id: string, fabricColorId: string | null, sortOrder: number): Image => ({
    id,
    storageKey: `key/${id}`,
    fabricColorId,
    altText: null,
    sortOrder,
    width: 800,
    height: 1200,
  });
  // Swatch order (creation date, as the storefront query returns it): navy before beige, so the
  // gallery's colour groups follow it, not alphabetical order.
  const colors = [
    { id: "navy", name: "Navy", hex: null },
    { id: "beige", name: "Beige", hex: null },
    { id: "taupe", name: "Taupe", hex: null },
  ];

  test("general photos first, then each colour's photos in swatch order, each group by sortOrder", () => {
    const view = buildProductView(
      baseProduct({
        colors,
        images: [
          image("beige-2", "beige", 1),
          image("general-2", null, 1),
          image("navy-1", "navy", 0),
          image("beige-1", "beige", 0),
          image("general-1", null, 0),
        ],
      }),
    );
    const gallery = buildProductGallery(view);
    expect(gallery.images.map((i) => [i.id, i.colorId])).toEqual([
      ["general-1", null],
      ["general-2", null],
      ["navy-1", "navy"],
      ["beige-1", "beige"],
      ["beige-2", "beige"],
    ]);
    // Taupe has no photo of its own: no start index.
    expect(gallery.colorStartIndex).toEqual({ navy: 2, beige: 3 });
  });

  test("carries alt text (product name as fallback) and the photo's own width and height", () => {
    const view = buildProductView(
      baseProduct({ colors, images: [{ ...image("general-1", null, 0), width: 1000, height: 1250 }, { ...image("navy-1", "navy", 0), altText: "Navy depan" }] }),
    );
    const [general, navy] = buildProductGallery(view).images;
    expect(general).toMatchObject({ altText: "Gamis Flowy Straight", width: 1000, height: 1250, storageKey: "key/general-1" });
    expect(navy?.altText).toBe("Navy depan");
  });

  test("photos of a colour without a swatch (deactivated) are left out", () => {
    const view = buildProductView(baseProduct({ colors, images: [image("general-1", null, 0), image("old-1", "deactivated", 0)] }));
    const gallery = buildProductGallery(view);
    expect(gallery.images.map((i) => i.id)).toEqual(["general-1"]);
    expect(gallery.colorStartIndex).toEqual({});
  });

  test("...unless they are the product's only photos: never empty while any photo exists", () => {
    const view = buildProductView(baseProduct({ colors, images: [image("old-1", "deactivated", 0)] }));
    expect(buildProductGallery(view).images.map((i) => i.id)).toEqual(["old-1"]);
  });

  test("no photo at all: an empty gallery; one photo: a gallery of one", () => {
    expect(buildProductGallery(buildProductView(baseProduct({ colors }))).images).toEqual([]);
    expect(buildProductGallery(buildProductView(baseProduct({ colors, images: [image("navy-1", "navy", 0)] }))).images).toHaveLength(1);
  });
});

describe("initialGalleryIndex", () => {
  const view = buildProductView(
    baseProduct({
      colors: [
        { id: "navy", name: "Navy", hex: null },
        { id: "beige", name: "Beige", hex: null },
      ],
      images: [
        { id: "general-1", storageKey: "g/1", fabricColorId: null, altText: null, sortOrder: 0, width: 800, height: 1200 },
        { id: "beige-1", storageKey: "b/1", fabricColorId: "beige", altText: null, sortOrder: 0, width: 800, height: 1200 },
      ],
    }),
  );
  const gallery = buildProductGallery(view);

  test("a valid ?color= with photos starts on that colour's first photo", () => {
    expect(initialGalleryIndex(view, gallery, "beige")).toBe(1);
  });

  test("no ?color=, an unknown one, or a colour without photos starts on the first photo", () => {
    expect(initialGalleryIndex(view, gallery, null)).toBe(0);
    expect(initialGalleryIndex(view, gallery, "deactivated-color-id")).toBe(0);
    expect(initialGalleryIndex(view, gallery, "navy")).toBe(0);
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
