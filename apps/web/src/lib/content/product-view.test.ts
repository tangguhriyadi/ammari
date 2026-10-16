import { describe, expect, test } from "vitest";
import type { StorefrontProduct } from "@ammari/db/storefront";
import { buildProductView, getGalleryForColor, resolveSelectedColorId } from "./product-view";

function baseProduct(overrides: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: "product-1",
    name: "Gamis Flowy Straight",
    slug: "gamis-flowy-straight",
    basePrice: 269_000,
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

  test("a colour with zero images of any kind gets an empty gallery, never throws", () => {
    const product = baseProduct({ colors: [{ id: "beige", name: "Beige", hex: null }], images: [] });
    const view = buildProductView(product);
    expect(getGalleryForColor(view, "beige")).toEqual([]);
  });

  test("sized product: availability per colour, in CUTTING_SIZES order, missing sizes read as unavailable", () => {
    const product = baseProduct({
      sizeMode: "sized",
      colors: [{ id: "beige", name: "Beige", hex: null }],
      variants: [
        { sku: "SKU-M", fabricColorId: "beige", size: "M", available: true },
        { sku: "SKU-S", fabricColorId: "beige", size: "S", available: false },
      ],
    });
    const view = buildProductView(product);
    expect(view.sizeOptionsByColor?.beige).toEqual([
      { size: "XS", available: false },
      { size: "S", available: false },
      { size: "M", available: true },
      { size: "L", available: false },
      { size: "XL", available: false },
    ]);
    expect(view.allsizeAvailableByColor).toBeNull();
  });

  test("all_size product: no size options, just a per-colour ALLSIZE availability map", () => {
    const product = baseProduct({
      sizeMode: "all_size",
      colors: [{ id: "beige", name: "Beige", hex: null }],
      variants: [{ sku: "SKU-ALLSIZE", fabricColorId: "beige", size: "ALLSIZE", available: true }],
    });
    const view = buildProductView(product);
    expect(view.sizeOptionsByColor).toBeNull();
    expect(view.allsizeAvailableByColor).toEqual({ beige: true });
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
