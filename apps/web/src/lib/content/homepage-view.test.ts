import { describe, expect, test } from "vitest";
import type { HomepageSectionContent } from "@ammari/db/storefront";
import { buildHomepageView } from "./homepage-view";

function sections(overrides: Partial<Record<HomepageSectionContent["key"], Partial<HomepageSectionContent>>>): HomepageSectionContent[] {
  const defaults: Record<HomepageSectionContent["key"], HomepageSectionContent> = {
    hero: { key: "hero", isVisible: true, content: { headline: "Graceful in every thread", eyebrow: "Koleksi", ctaLabel: "Lihat", ctaTarget: { type: "anchor" }, image: null } },
    product_grid: { key: "product_grid", isVisible: true, content: { title: "Koleksi perdana", tiles: [{ productId: "p1", fabricColorId: null }] } },
    feature_block: { key: "feature_block", isVisible: true, content: { title: "Outer Dress", subtitle: "Dalam dan luar satu warna", ctaLabel: "Lihat", linkedProduct: { productId: "p2", fabricColorId: "c1" }, image: null } },
    why_ammari: { key: "why_ammari", isVisible: true, content: { eyebrow: "Kenapa Ammari", heading: "Nyaman dipakai seharian", points: [{ icon: "easy_care", title: "Mudah dirawat", text: "Cukup dicuci biasa" }] } },
  };
  const merged = { ...defaults };
  for (const key of Object.keys(overrides) as HomepageSectionContent["key"][]) {
    merged[key] = { ...defaults[key], ...overrides[key] } as HomepageSectionContent;
  }
  return Object.values(merged);
}

describe("buildHomepageView", () => {
  test("hidden sections (isVisible: false) are not rendered, regardless of content", () => {
    const view = buildHomepageView(sections({ hero: { isVisible: false } }));
    expect(view.hero).toBeNull();
    expect(view.productGrid).not.toBeNull();
  });

  test("a never-published section (content: null) is not rendered", () => {
    const view = buildHomepageView(sections({ feature_block: { isVisible: true, content: null } }));
    expect(view.featureBlock).toBeNull();
  });

  test("an empty product grid (no tiles) is treated as empty, not rendered", () => {
    const view = buildHomepageView(sections({ product_grid: { content: { title: "Koleksi", tiles: [] } } }));
    expect(view.productGrid).toBeNull();
  });

  test("a hero with no headline is treated as empty, not rendered", () => {
    const view = buildHomepageView(sections({ hero: { content: { headline: "", eyebrow: "x", ctaLabel: "x", ctaTarget: { type: "anchor" }, image: null } } }));
    expect(view.hero).toBeNull();
  });

  test("a feature block with no linked product is treated as empty, not rendered", () => {
    const view = buildHomepageView(sections({ feature_block: { content: { title: "x", subtitle: "x", ctaLabel: "x", linkedProduct: {}, image: null } } }));
    expect(view.featureBlock).toBeNull();
  });

  test("a why_ammari point with an unrecognized icon key is skipped, not crashed on", () => {
    const view = buildHomepageView(
      sections({
        why_ammari: {
          content: {
            eyebrow: "x",
            heading: "x",
            points: [
              { icon: "not_a_real_icon", title: "Bad point", text: "x" },
              { icon: "easy_care", title: "Good point", text: "x" },
            ],
          },
        },
      }),
    );
    expect(view.whyAmmari?.points.map((p) => p.title)).toEqual(["Good point"]);
  });

  test("why_ammari points are capped at 4, even if the stored content somehow has more", () => {
    const points = Array.from({ length: 6 }, (_, i) => ({ icon: "easy_care", title: `Point ${i}`, text: "x" }));
    const view = buildHomepageView(sections({ why_ammari: { content: { eyebrow: "x", heading: "x", points } } }));
    expect(view.whyAmmari?.points.length).toBe(4);
  });

  test("hero's product CTA target resolves the embedded product ref; malformed refs fall back to anchor", () => {
    const withProduct = buildHomepageView(
      sections({ hero: { content: { headline: "x", eyebrow: "x", ctaLabel: "x", ctaTarget: { type: "product", productId: "p1", fabricColorId: null }, image: null } } }),
    );
    expect(withProduct.hero?.ctaTarget).toEqual({ type: "product", ref: { productId: "p1", fabricColorId: null } });

    const malformed = buildHomepageView(
      sections({ hero: { content: { headline: "x", eyebrow: "x", ctaLabel: "x", ctaTarget: { type: "product" }, image: null } } }),
    );
    expect(malformed.hero?.ctaTarget).toEqual({ type: "anchor" });
  });

  test("completely malformed content (wrong type) never throws — treated as empty", () => {
    expect(() => buildHomepageView(sections({ hero: { content: "not an object" as never } }))).not.toThrow();
    expect(buildHomepageView(sections({ hero: { content: "not an object" as never } })).hero).toBeNull();
  });
});
