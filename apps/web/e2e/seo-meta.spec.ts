import { expect, test, type Page } from "@playwright/test";
import { E2E_HERO_ALT_TEXT, E2E_HERO_OG_IMAGE_KEY, E2E_PRODUCT_NAME, E2E_PRODUCT_SLUG, E2E_SOLD_OUT_PRODUCT_SLUG } from "./storefront-fixtures";
import { E2E_STOREFRONT_SETTINGS_DEFAULTS, setStorefrontSettings } from "./helpers/store-settings-db";

// Open Graph / Twitter tags and the editable homepage meta (docs/design/storefront.md §9 "SEO
// and social previews"). STORAGE_PUBLIC_BASE_URL is this e2e server's own origin
// (playwright.config.ts), so the Hero's generated OG JPEG resolves to the fixtures route.

const STORAGE_BASE = "http://localhost:3100";
const HERO_OG_URL = `${STORAGE_BASE}/${E2E_HERO_OG_IMAGE_KEY}`;

async function meta(page: Page, attribute: "property" | "name", key: string): Promise<string | null> {
  const locator = page.locator(`meta[${attribute}="${key}"]`);
  if ((await locator.count()) === 0) return null;
  return locator.first().getAttribute("content");
}

async function expectHeroOgImage(page: Page): Promise<void> {
  expect(await meta(page, "property", "og:image")).toBe(HERO_OG_URL);
  expect(await meta(page, "property", "og:image:width")).toBe("1200");
  expect(await meta(page, "property", "og:image:height")).toBe("630");
  expect(await meta(page, "property", "og:image:alt")).toBe(E2E_HERO_ALT_TEXT);
  expect(await meta(page, "name", "twitter:card")).toBe("summary_large_image");
  expect(await meta(page, "name", "twitter:image")).toBe(HERO_OG_URL);
}

test.describe("Open Graph image", () => {
  test("the homepage uses the published Hero's 1200x630 JPEG, and it is served", async ({ page, request }) => {
    await page.goto("/");
    await expectHeroOgImage(page);

    const response = await request.get(HERO_OG_URL);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/jpeg");
    const body = await response.body();
    expect(body.length).toBeLessThan(300 * 1024);
    // JPEG SOF0/SOF2 frame header carries height then width (big-endian) right after the marker.
    const sof = body.findIndex((byte, index) => byte === 0xff && (body[index + 1] === 0xc0 || body[index + 1] === 0xc2));
    expect(sof).toBeGreaterThan(0);
    expect({ height: body.readUInt16BE(sof + 5), width: body.readUInt16BE(sof + 7) }).toEqual({ height: 630, width: 1200 });
  });

  test("an info page uses the Hero OG image too, and keeps its own title", async ({ page }) => {
    await page.goto("/shipping");
    await expect(page).toHaveTitle("Pengiriman | Ammari");
    await expectHeroOgImage(page);
    expect(await meta(page, "property", "og:title")).toBe("Pengiriman | Ammari");
  });

  test("the not-found page and the login page use the Hero OG image", async ({ page }) => {
    const response = await page.goto("/halaman-yang-tidak-ada");
    expect(response?.status()).toBe(404);
    await expectHeroOgImage(page);

    await page.goto("/login");
    await expectHeroOgImage(page);
  });

  test("a product page keeps its own main photo as the OG image, never the Hero", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    const ogImage = await meta(page, "property", "og:image");
    expect(ogImage).toBe(`${STORAGE_BASE}/api/test/fixtures/general/1600.webp`);
    expect(await meta(page, "name", "twitter:image")).toBe(ogImage);
    expect(await meta(page, "property", "og:title")).toBe(E2E_PRODUCT_NAME);
    await expect(page).toHaveTitle(`${E2E_PRODUCT_NAME} | Ammari`);
  });

  test("a product page's canonical URL never carries ?color=", async ({ page }) => {
    for (const path of [`/products/${E2E_PRODUCT_SLUG}`, `/products/${E2E_PRODUCT_SLUG}?color=any-colour-id`]) {
      await page.goto(path);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toMatch(new RegExp(`^https?://[^/]+/products/${E2E_PRODUCT_SLUG}$`));
    }
  });
});

async function jsonLd(page: Page): Promise<Record<string, unknown>[]> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  return scripts.flatMap((text) => {
    const parsed = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function ofType(items: Record<string, unknown>[], type: string): Record<string, unknown> {
  const found = items.find((item) => item["@type"] === type);
  if (!found) throw new Error(`no ${type} JSON-LD`);
  return found;
}

test.describe("product page SEO (docs/plans/seo.md)", () => {
  test("canonical, Open Graph and a clean meta description", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}?color=any-colour-id`);
    const canonical = `${STORAGE_BASE}/products/${E2E_PRODUCT_SLUG}`;
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    expect(await meta(page, "property", "og:url")).toBe(canonical);
    expect(await meta(page, "property", "og:site_name")).toBe("Ammari");
    expect(await meta(page, "property", "og:locale")).toBe("id_ID");
    expect(await meta(page, "property", "og:type")).toBe("website");
    expect(await meta(page, "property", "og:image:type")).toBe("image/webp");
    expect(Number(await meta(page, "property", "og:image:width"))).toBeGreaterThan(0);
    expect(Number(await meta(page, "property", "og:image:height"))).toBeGreaterThan(0);
    expect(await meta(page, "property", "og:image:alt")).toBeTruthy();

    // storefront-fixtures.ts: "<p>Potongan lurus ...</p><ul><li>Resleting ...</li><li>Saku ...</li></ul>"
    const description = await meta(page, "name", "description");
    expect(description).toBe("Potongan lurus yang tetap jatuh flowy. Resleting depan tertutup kain Saku tersembunyi");
    expect(await meta(page, "property", "og:description")).toBe(description);
  });

  test("Product and BreadcrumbList JSON-LD at the canonical URL", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}?color=any-colour-id`);
    const items = await jsonLd(page);
    const canonical = `${STORAGE_BASE}/products/${E2E_PRODUCT_SLUG}`;

    const product = ofType(items, "Product");
    expect(product).toMatchObject({ name: E2E_PRODUCT_NAME, url: canonical, brand: { "@type": "Brand", name: "Ammari" } });
    expect(Array.isArray(product.image) && product.image.length).toBeGreaterThan(0);
    const offers = product.offers as Record<string, unknown>;
    expect(offers).toMatchObject({ "@type": "Offer", url: canonical, priceCurrency: "IDR", availability: "https://schema.org/InStock" });
    expect(typeof offers.price).toBe("number");

    expect(ofType(items, "BreadcrumbList").itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Beranda", item: `${STORAGE_BASE}/` },
      { "@type": "ListItem", position: 2, name: E2E_PRODUCT_NAME, item: canonical },
    ]);
  });

  test("a sold-out product is OutOfStock", async ({ page }) => {
    await page.goto(`/products/${E2E_SOLD_OUT_PRODUCT_SLUG}`);
    const offers = ofType(await jsonLd(page), "Product").offers as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/OutOfStock");
  });

  test("the homepage has Organization + WebSite JSON-LD, a canonical URL and one h1", async ({ page }) => {
    await page.goto("/?voucher=claimed");
    // Next prints the root canonical without the trailing slash; same URL.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", STORAGE_BASE);
    const items = await jsonLd(page);
    expect(ofType(items, "Organization")).toMatchObject({ name: "Ammari", url: `${STORAGE_BASE}/`, logo: `${STORAGE_BASE}/logos/ammari-primary.png` });
    expect(ofType(items, "WebSite")).toMatchObject({ name: "Ammari", inLanguage: "id-ID" });
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
  });

  test("an info page has a description, canonical URL and breadcrumb", async ({ page }) => {
    await page.goto("/shipping");
    expect(await meta(page, "name", "description")).toBe("Pengiriman E2E dikirim via kurir pilihan.");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${STORAGE_BASE}/shipping`);
    expect(ofType(await jsonLd(page), "BreadcrumbList").itemListElement).toHaveLength(2);
  });
});

test.describe("homepage meta title and description", () => {
  test.afterEach(async () => {
    await setStorefrontSettings(E2E_STOREFRONT_SETTINGS_DEFAULTS);
  });

  test("defaults when nothing is set", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Ammari | Graceful in every thread");
    const description = await meta(page, "name", "description");
    expect(description).toBe(
      "Gamis syar'i Ammari. Desain syar'i yang anggun, bahan premium, dan nyaman dipakai seharian. Subsidi ongkir hingga Rp20.000.",
    );
    expect(await meta(page, "property", "og:title")).toBe("Ammari | Graceful in every thread");
    expect(await meta(page, "property", "og:description")).toBe(description);
  });

  test("the owner's text from Pengaturan Toko drives <title>, meta description, og:title and og:description", async ({ page }) => {
    await setStorefrontSettings({
      homepageMetaTitle: "Ammari | Gamis Syar'i E2E",
      homepageMetaDescription: "Deskripsi beranda E2E untuk Google dan WhatsApp.",
    });
    await page.goto("/");
    await expect(page).toHaveTitle("Ammari | Gamis Syar'i E2E");
    expect(await meta(page, "name", "description")).toBe("Deskripsi beranda E2E untuk Google dan WhatsApp.");
    expect(await meta(page, "property", "og:title")).toBe("Ammari | Gamis Syar'i E2E");
    expect(await meta(page, "property", "og:description")).toBe("Deskripsi beranda E2E untuk Google dan WhatsApp.");
    expect(await meta(page, "name", "twitter:title")).toBe("Ammari | Gamis Syar'i E2E");
    await expectHeroOgImage(page);

    // Other pages keep their own "Name | Ammari" titles.
    await page.goto("/shipping");
    await expect(page).toHaveTitle("Pengiriman | Ammari");
  });
});
