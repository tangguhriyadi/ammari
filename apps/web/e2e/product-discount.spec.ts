import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  E2E_DISCOUNT_ACTIVE_NAME,
  E2E_DISCOUNT_ACTIVE_SLUG,
  E2E_DISCOUNT_ENDED_SLUG,
  E2E_DISCOUNT_FLIP_SLUG,
  E2E_DISCOUNT_SCHEDULED_NAME,
  E2E_DISCOUNT_SCHEDULED_SLUG,
  E2E_DISCOUNT_SOLD_OUT_NAME,
  E2E_DISCOUNT_SOLD_OUT_SLUG,
} from "./discount-fixtures";
import { saveDiscountWindow } from "./helpers/discount-db";

// docs/plans/product-discount.md session 3: storefront display + caching. Runs the same with the
// cart flag off (the shipped default, WhatsApp ordering) and on (`pnpm test:e2e:cart`): price
// display does not depend on it. Fixtures: e2e/discount-fixtures.ts (350.000 -> 279.000, 20% OFF).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

const DISCOUNT_RED = "rgb(208, 93, 92)"; // #D05D5C
const WHITE = "rgb(255, 255, 255)";

async function openPdp(page: Page, slug: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/products/${slug}`);
}

/** The PDP's own name + price block, not the related tiles below it. */
function pdpPrice(page: Page): Locator {
  return page.getByRole("heading", { level: 1 }).locator("xpath=..").getByTestId("product-price");
}

function relatedTile(page: Page, name: string): Locator {
  return page.getByRole("link", { name: new RegExp(name) });
}

async function productJsonLd(page: Page): Promise<{ offers: { price: number; priceValidUntil?: string; availability: string } }> {
  for (const text of await page.locator('script[type="application/ld+json"]').allTextContents()) {
    const parsed = JSON.parse(text) as { "@type"?: string };
    if (parsed["@type"] === "Product") return parsed as { offers: { price: number; priceValidUntil?: string; availability: string } };
  }
  throw new Error("no Product JSON-LD on the page");
}

async function expectDiscountedPrice(price: Locator) {
  const list = price.getByTestId("product-price-list");
  const sale = price.getByTestId("product-price-sale");
  await expect(list).toHaveText("Rp350.000");
  await expect(list).toHaveCSS("text-decoration-line", "line-through");
  await expect(sale).toHaveText("Rp279.000");
  await expect(sale).toHaveCSS("color", DISCOUNT_RED);
  await expect(price.getByText("Harga normal Rp350.000, harga diskon Rp279.000")).toBeAttached();
}

async function expectNormalPrice(price: Locator) {
  await expect(price).toHaveText("Rp350.000");
  await expect(price.getByTestId("product-price-list")).toHaveCount(0);
  await expect(price.getByTestId("product-price-sale")).toHaveCount(0);
}

test.describe("product discount on the storefront", () => {
  // The time-flip tests share one fixture product; never run them side by side.
  test.describe.configure({ mode: "serial" });
  for (const viewport of VIEWPORTS) {
    test(`active: PDP shows the normal price struck and the sale price in red, no badge; JSON-LD has the sale price (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_DISCOUNT_ACTIVE_SLUG, viewport);
      await expectDiscountedPrice(pdpPrice(page));
      await expect(page.getByRole("heading", { level: 1 }).locator("xpath=..").getByText(/% OFF/)).toHaveCount(0);

      const jsonLd = await productJsonLd(page);
      expect(jsonLd.offers.price).toBe(279_000);
      expect(jsonLd.offers.priceValidUntil).toBe("2099-12-31");
    });

    test(`tiles: an active discount gets the bold 20% OFF badge; a sold-out discounted product only "Sold out", prices still struck + red (${viewport.name})`, async ({ page }) => {
      // The ended product's related list: the active and the sold-out discounted products.
      await openPdp(page, E2E_DISCOUNT_ENDED_SLUG, viewport);

      const active = relatedTile(page, E2E_DISCOUNT_ACTIVE_NAME);
      const badge = active.getByTestId("discount-badge");
      await expect(badge).toHaveText("20% OFF");
      await expect(badge).toHaveCSS("background-color", DISCOUNT_RED);
      await expect(badge).toHaveCSS("color", WHITE);
      await expect(badge).toHaveCSS("font-weight", "700");
      await expect(badge).toHaveCSS("font-size", "19px");
      // The badge fits on the tile's photo at this width, on one line.
      const badgeBox = await badge.boundingBox();
      const tileBox = await active.boundingBox();
      expect(badgeBox!.width).toBeLessThan(tileBox!.width * 0.75);
      expect(badgeBox!.height).toBeLessThan(40);
      await expectDiscountedPrice(active.getByTestId("product-price"));

      const soldOut = relatedTile(page, E2E_DISCOUNT_SOLD_OUT_NAME);
      await expect(soldOut.getByText("Sold out")).toBeVisible();
      await expect(soldOut.getByTestId("discount-badge")).toHaveCount(0);
      await expect(soldOut.getByText(/% OFF/)).toHaveCount(0);
      await expectDiscountedPrice(soldOut.getByTestId("product-price"));
    });

    test(`scheduled, not started yet: PDP and tile show only the normal price, nothing about the discount (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_DISCOUNT_SCHEDULED_SLUG, viewport);
      await expectNormalPrice(pdpPrice(page));
      const jsonLd = await productJsonLd(page);
      expect(jsonLd.offers.price).toBe(350_000);
      expect(jsonLd.offers.priceValidUntil).toBeUndefined();

      // Its tile, in the active product's related list.
      await openPdp(page, E2E_DISCOUNT_ACTIVE_SLUG, viewport);
      const tile = relatedTile(page, E2E_DISCOUNT_SCHEDULED_NAME);
      await expectNormalPrice(tile.getByTestId("product-price"));
      await expect(tile.getByTestId("discount-badge")).toHaveCount(0);
    });

    test(`ended: PDP shows only the normal price (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_DISCOUNT_ENDED_SLUG, viewport);
      await expectNormalPrice(pdpPrice(page));
      expect((await productJsonLd(page)).offers.price).toBe(350_000);
    });

    test(`sold out with an active discount: PDP keeps struck + red prices next to SOLD OUT (${viewport.name})`, async ({ page }) => {
      await openPdp(page, E2E_DISCOUNT_SOLD_OUT_SLUG, viewport);
      await expectDiscountedPrice(pdpPrice(page));
      await expect(page.getByRole("button", { name: "SOLD OUT" })).toBeDisabled();
      const jsonLd = await productJsonLd(page);
      expect(jsonLd.offers.price).toBe(279_000);
      expect(jsonLd.offers.availability).toBe("https://schema.org/OutOfStock");
    });

    test(`a saved schedule starts and ends exactly on reload, with no revalidation in between (plan §7) (${viewport.name})`, async ({ page, request }) => {
      test.setTimeout(90_000);
      // Saved once, like the admin "Simpan diskon" (DB write + revalidation). Nothing is called after.
      // Wide margins so a slow dev-server render cannot push a check past a boundary.
      const startsAt = new Date(Date.now() + 10_000);
      const endsAt = new Date(startsAt.getTime() + 10_000);
      await saveDiscountWindow(request, E2E_DISCOUNT_FLIP_SLUG, { enabled: true, startsAt, endsAt });

      await openPdp(page, E2E_DISCOUNT_FLIP_SLUG, viewport);
      const beforeStart = await pdpPrice(page).textContent();
      expect(Date.now(), "the page must load before the start time for this test to mean anything").toBeLessThan(startsAt.getTime());
      expect(beforeStart).toBe("Rp350.000");

      await page.waitForTimeout(startsAt.getTime() - Date.now() + 300);
      await page.reload();
      const duringJsonLd = await productJsonLd(page);
      expect(Date.now(), "the page must load before the end time for this test to mean anything").toBeLessThan(endsAt.getTime());
      expect(duringJsonLd.offers.price).toBe(279_000);
      await expectDiscountedPrice(pdpPrice(page));

      await page.waitForTimeout(endsAt.getTime() - Date.now() + 300);
      await page.reload();
      await expectNormalPrice(pdpPrice(page));
      expect((await productJsonLd(page)).offers.price).toBe(350_000);

      await saveDiscountWindow(request, E2E_DISCOUNT_FLIP_SLUG, { enabled: false, startsAt: null, endsAt: null });
    });
  }
});
