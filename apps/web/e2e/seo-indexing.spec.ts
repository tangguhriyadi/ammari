import { expect, test, type Page } from "@playwright/test";
import { E2E_PRODUCT_SLUG, E2E_SOLD_OUT_PRODUCT_SLUG, E2E_UNPUBLISHED_PRODUCT_SLUG } from "./storefront-fixtures";

// Indexing safety and crawl files (docs/plans/seo.md). The e2e server runs with DEPLOY_ENV unset,
// i.e. exactly what a dev / non-production host looks like: everything must be noindex there.
// The production branch of the same rules is unit-tested (lib/seo/indexing.test.ts,
// app/robots.test.ts), since one server can only run one environment.

const ORIGIN = "http://localhost:3100";

async function robotsMeta(page: Page): Promise<string | null> {
  const locator = page.locator('meta[name="robots"]');
  return (await locator.count()) === 0 ? null : locator.first().getAttribute("content");
}

test.describe("non-production host", () => {
  test("robots.txt disallows everything and names no sitemap", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("User-Agent: *");
    expect(body).toMatch(/^Disallow: \/$/m);
    expect(body).not.toContain("Sitemap:");
  });

  test("every response carries X-Robots-Tag noindex: pages, crawl files, static images, API", async ({ request }) => {
    for (const path of ["/", `/products/${E2E_PRODUCT_SLUG}`, "/shipping", "/robots.txt", "/sitemap.xml", "/images/product-placeholder-og.jpg", "/api/health"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
    }
  });

  test("public pages carry the robots noindex meta too", async ({ page }) => {
    for (const path of ["/", `/products/${E2E_PRODUCT_SLUG}`, "/shipping", "/privacy-policy"]) {
      await page.goto(path);
      expect(await robotsMeta(page), path).toBe("noindex, nofollow");
    }
  });
});

test.describe("private routes", () => {
  test("carry noindex as a meta tag and a header", async ({ page }) => {
    // /account and /consent redirect a visitor without a session to /login, which is private too.
    for (const path of ["/login", "/claim", "/account", "/consent"]) {
      const response = await page.goto(path);
      expect(response?.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
      expect(await robotsMeta(page), path).toBe("noindex, nofollow");
    }
  });

  test("a claim token page is noindex", async ({ page }) => {
    const response = await page.goto("/claim/TIDAK-ADA-E2E");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(await robotsMeta(page)).toBe("noindex, nofollow");
  });

  test("an unpublished info page (stub) is noindex", async ({ page }) => {
    await page.goto("/how-to-order");
    expect(await robotsMeta(page)).toBe("noindex, nofollow");
  });
});

test.describe("sitemap.xml", () => {
  test("lists home, published products and published info pages at canonical URLs only", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("xml");
    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");

    expect(locs).toContain(`${ORIGIN}/`);
    expect(locs).toContain(`${ORIGIN}/products/${E2E_PRODUCT_SLUG}`);
    // Sold out is still a product page (OutOfStock in its JSON-LD), so it stays listed.
    expect(locs).toContain(`${ORIGIN}/products/${E2E_SOLD_OUT_PRODUCT_SLUG}`);
    expect(locs).toContain(`${ORIGIN}/shipping`);
    expect(locs).toContain(`${ORIGIN}/privacy-policy`);
    expect(locs).not.toContain(`${ORIGIN}/products/${E2E_UNPUBLISHED_PRODUCT_SLUG}`);
    // Left unpublished by the fixtures: a "sedang disiapkan" stub is not listed.
    expect(locs).not.toContain(`${ORIGIN}/how-to-order`);

    for (const loc of locs) {
      const url = new URL(loc);
      expect(url.origin, loc).toBe(ORIGIN);
      expect(url.search, loc).toBe("");
      expect(url.pathname, loc).not.toMatch(/^\/(cart|checkout|account|orders|login|claim|consent|preview|api)(\/|$)/);
    }
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
  });
});

test.describe("not found", () => {
  test("an unknown product is a real 404 with links back to the collection", async ({ page }) => {
    const response = await page.goto("/products/produk-yang-tidak-ada-e2e");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Halaman Tidak Ditemukan");
    await expect(page.getByRole("link", { name: "Lihat koleksi" })).toHaveAttribute("href", "/#koleksi");
    await expect(page.getByRole("link", { name: "Kembali ke halaman utama" })).toHaveAttribute("href", "/");
  });
});
