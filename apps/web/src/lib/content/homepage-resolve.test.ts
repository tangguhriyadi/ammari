import { describe, expect, test } from "vitest";
import type { PricedProductTile } from "@/lib/content/storefront-price";
import type { HomepageView } from "./homepage-view";
import { collectHomepageProductRefs, resolveHomepageView } from "./homepage-resolve";

function tile(overrides: Partial<PricedProductTile> = {}): PricedProductTile {
  return {
    productId: "p1",
    fabricColorId: null,
    name: "Gamis Flowy Straight",
    slug: "gamis-flowy-straight",
    price: { listPrice: 269_000, unitPrice: 269_000, discounted: false, percentOff: null },
    colorName: "Beige",
    colorCount: 1,
    soldOut: false,
    image: null,
    ...overrides,
  };
}

function baseView(overrides: Partial<HomepageView> = {}): HomepageView {
  return { hero: null, productGrid: null, featureBlock: null, whyAmmari: null, ...overrides };
}

describe("collectHomepageProductRefs", () => {
  test("gathers refs from hero's product CTA, every grid tile, and the feature block's linked product, deduped", () => {
    const view = baseView({
      hero: { eyebrow: "x", headline: "x", ctaLabel: "x", ctaTarget: { type: "product", ref: { productId: "p1", fabricColorId: null } }, image: null },
      productGrid: { title: "x", tiles: [{ productId: "p1", fabricColorId: null }, { productId: "p2", fabricColorId: "c1" }] },
      featureBlock: { title: "x", subtitle: "x", ctaLabel: "x", linkedProduct: { productId: "p2", fabricColorId: "c1" }, image: null },
    });
    const refs = collectHomepageProductRefs(view);
    expect(refs).toEqual([
      { productId: "p1", fabricColorId: null },
      { productId: "p2", fabricColorId: "c1" },
    ]);
  });

  test("an anchor-type hero CTA contributes no ref", () => {
    const view = baseView({ hero: { eyebrow: "x", headline: "x", ctaLabel: "x", ctaTarget: { type: "anchor" }, image: null } });
    expect(collectHomepageProductRefs(view)).toEqual([]);
  });
});

describe("resolveHomepageView", () => {
  test("a product-type hero CTA resolves to the product's URL, with ?color= when a colour is pinned", () => {
    const view = baseView({ hero: { eyebrow: "x", headline: "x", ctaLabel: "x", ctaTarget: { type: "product", ref: { productId: "p1", fabricColorId: "c1" } }, image: null } });
    const resolved = resolveHomepageView(view, [tile({ productId: "p1", fabricColorId: "c1", slug: "gamis-x" })]);
    expect(resolved.hero?.ctaHref).toBe("/products/gamis-x?color=c1");
  });

  test("a hero CTA pointing at a since-deleted product falls back to the #koleksi anchor", () => {
    const view = baseView({ hero: { eyebrow: "x", headline: "x", ctaLabel: "x", ctaTarget: { type: "product", ref: { productId: "gone", fabricColorId: null } }, image: null } });
    const resolved = resolveHomepageView(view, []);
    expect(resolved.hero?.ctaHref).toBe("#koleksi");
  });

  test("an anchor-type hero CTA always resolves to #koleksi", () => {
    const view = baseView({ hero: { eyebrow: "x", headline: "x", ctaLabel: "x", ctaTarget: { type: "anchor" }, image: null } });
    expect(resolveHomepageView(view, []).hero?.ctaHref).toBe("#koleksi");
  });

  test("a product grid drops tiles that didn't resolve, keeping the ones that did", () => {
    const view = baseView({ productGrid: { title: "Koleksi", tiles: [{ productId: "p1", fabricColorId: null }, { productId: "gone", fabricColorId: null }] } });
    const resolved = resolveHomepageView(view, [tile({ productId: "p1" })]);
    expect(resolved.productGrid?.tiles.map((t) => t.productId)).toEqual(["p1"]);
  });

  test("a product grid where EVERY tile fails to resolve is treated as empty — not rendered", () => {
    const view = baseView({ productGrid: { title: "Koleksi", tiles: [{ productId: "gone", fabricColorId: null }] } });
    const resolved = resolveHomepageView(view, []);
    expect(resolved.productGrid).toBeNull();
  });

  test("a feature block whose linked product fails to resolve is treated as empty — not rendered", () => {
    const view = baseView({ featureBlock: { title: "x", subtitle: "x", ctaLabel: "x", linkedProduct: { productId: "gone", fabricColorId: null }, image: null } });
    const resolved = resolveHomepageView(view, []);
    expect(resolved.featureBlock).toBeNull();
  });

  test("a feature block whose linked product resolves gets a real href", () => {
    const view = baseView({ featureBlock: { title: "x", subtitle: "x", ctaLabel: "Lihat", linkedProduct: { productId: "p2", fabricColorId: null }, image: null } });
    const resolved = resolveHomepageView(view, [tile({ productId: "p2", slug: "outer-dress" })]);
    expect(resolved.featureBlock?.href).toBe("/products/outer-dress");
    expect(resolved.featureBlock?.linkedProduct.slug).toBe("outer-dress");
  });

  test("why_ammari passes through unchanged — nothing in it needs product resolution", () => {
    const view = baseView({ whyAmmari: { eyebrow: "x", heading: "x", points: [{ icon: "easy_care", title: "x", text: "x" }] } });
    expect(resolveHomepageView(view, []).whyAmmari).toEqual(view.whyAmmari);
  });
});
