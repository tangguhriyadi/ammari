import { describe, expect, test } from "vitest";
import { buildSitemap } from "./sitemap";

const ORIGIN = "https://ammari.id";

describe("buildSitemap", () => {
  test("home, products and published info pages at canonical URLs with lastModified from the data", () => {
    const productUpdated = new Date("2026-10-25T08:00:00.000Z");
    const infoPublished = new Date("2026-10-20T03:00:00.000Z");
    const homepagePublished = new Date("2026-10-21T03:00:00.000Z");
    const sitemap = buildSitemap(ORIGIN, {
      homepagePublishedAt: homepagePublished,
      products: [{ slug: "gamis-aira", updatedAt: productUpdated }],
      infoPages: [{ slug: "shipping", publishedAt: infoPublished }],
    });
    expect(sitemap).toEqual([
      { url: `${ORIGIN}/`, lastModified: homepagePublished, changeFrequency: "daily", priority: 1 },
      { url: `${ORIGIN}/products/gamis-aira`, lastModified: productUpdated, changeFrequency: "weekly", priority: 0.8 },
      { url: `${ORIGIN}/shipping`, lastModified: infoPublished, changeFrequency: "monthly", priority: 0.3 },
    ]);
  });

  test("never lists a query, a fragment or a private path", () => {
    const sitemap = buildSitemap(ORIGIN, { homepagePublishedAt: null, products: [{ slug: "gamis-aira", updatedAt: new Date() }], infoPages: [] });
    for (const entry of sitemap) {
      const url = new URL(entry.url);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.pathname).not.toMatch(/^\/(cart|checkout|account|orders|login|claim|consent|preview|api)(\/|$)/);
    }
  });

  test("an unknown or unparseable timestamp is left out, never invented", () => {
    const sitemap = buildSitemap(ORIGIN, {
      homepagePublishedAt: null,
      products: [{ slug: "gamis-aira", updatedAt: "not a date" as unknown as Date }],
      infoPages: [{ slug: "privacy-policy", publishedAt: null }],
    });
    for (const entry of sitemap) expect(entry).not.toHaveProperty("lastModified");
  });

  test("ISO strings (a cached read) are accepted", () => {
    const [, product] = buildSitemap(ORIGIN, {
      homepagePublishedAt: null,
      products: [{ slug: "gamis-aira", updatedAt: "2026-10-25T08:00:00.000Z" as unknown as Date }],
      infoPages: [],
    });
    expect(product?.lastModified).toEqual(new Date("2026-10-25T08:00:00.000Z"));
  });

  test("a slug is URL-encoded", () => {
    const [, product] = buildSitemap(ORIGIN, { homepagePublishedAt: null, products: [{ slug: "gamis aira", updatedAt: new Date() }], infoPages: [] });
    expect(product?.url).toBe(`${ORIGIN}/products/gamis%20aira`);
  });
});
