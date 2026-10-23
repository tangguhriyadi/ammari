import { expect, test, type Locator } from "@playwright/test";
import { E2E_NO_PHOTO_PRODUCT_NAME, E2E_NO_PHOTO_PRODUCT_SLUG, E2E_OTHER_COLOR_PHOTO_PRODUCT_SLUG } from "./storefront-fixtures";


/** Really loaded (not the broken-image icon), and drawn in a 2:3 box like every product photo. */
async function expectLoadedPortrait(image: Locator) {
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height / box!.width).toBeCloseTo(1.5, 1);
}

test.describe("storefront image fallback", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    test(`a product with no photo at all shows the Ammari placeholder, never a broken image (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/products/${E2E_NO_PHOTO_PRODUCT_SLUG}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(E2E_NO_PHOTO_PRODUCT_NAME);

      const image = page.getByTestId("gallery-current").locator("img");
      await expect(image).toHaveAttribute("alt", `Foto ${E2E_NO_PHOTO_PRODUCT_NAME} belum tersedia`);
      // Nothing to enlarge or browse: no main image button, no thumbnails.
      await expect(page.getByRole("button", { name: /^Perbesar foto/ })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Foto produk" })).toHaveCount(0);
      await expect(image).toHaveAttribute("src", /\/images\/product-placeholder-1600\.webp$/);
      await expectLoadedPortrait(image);
    });
  }

  test("the OG image of a photo-less product is the static placeholder, and it is served", async ({ page, request }) => {
    await page.goto(`/products/${E2E_NO_PHOTO_PRODUCT_SLUG}`);
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(ogImage).toMatch(/\/images\/product-placeholder-og\.jpg$/);
    const response = await request.get(new URL(ogImage!).pathname);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/jpeg");
  });

  test("a colour with no photo of its own (and no general photo) shows another colour's photo", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/products/${E2E_OTHER_COLOR_PHOTO_PRODUCT_SLUG}`);

    // Sage is the default (first) colour and has no photo; Mocca's photo stands in for it.
    await expect(page.getByText("Warna: Sage E2E")).toBeVisible();
    const image = page.getByTestId("gallery-current").locator("img");
    await expect(image).toHaveAttribute("alt", "Gamis Foto Warna Lain warna Mocca");
    await expectLoadedPortrait(image);

    await page.getByRole("button", { name: "Mocca E2E" }).click();
    await expect(image).toHaveAttribute("alt", "Gamis Foto Warna Lain warna Mocca");
  });
});
