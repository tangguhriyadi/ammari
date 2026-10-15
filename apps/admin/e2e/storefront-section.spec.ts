import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { E2E_PAGINATION_PRODUCT_PREFIX, E2E_PRODUCTS_NO_FINANCE_EMAIL, E2E_STOREFRONT_EMAIL } from "./global-setup";

async function jpegFixture(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 120, g: 90, b: 90 } } }).jpeg().toBuffer();
}

/** Creates a fabric+color, an ACTIVE product with one M variant on that color, and uploads one
 * photo WITH alt text to that color — everything the required-photo invariant AND the
 * storefront publish-time alt-text check both need satisfied, so the Storefront section's
 * publish toggle can actually succeed later in the same test. Returns the product's detail
 * page URL. */
async function createPublishablePhotoReadyProduct(page: Page, label: string): Promise<{ productId: string; productName: string }> {
  const unique = `${label}-${Date.now()}`;

  const fabricName = `E2E Bahan Storefront ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Storefront E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
  const productId = page.url().split("/products/")[1]!;

  await page.getByRole("checkbox", { name: /Sage/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();

  const sageGroup = page
    .locator('[data-testid^="photo-group-"]')
    .filter({ has: page.getByRole("heading", { name: "Sage", exact: true }) });
  await sageGroup.locator('input[type="file"]').setInputFiles({ name: "sage.jpg", mimeType: "image/jpeg", buffer: await jpegFixture() });
  // Two separate "save" buttons exist in the DOM at once (a phone-only `sm:hidden` one with the
  // `save-photos-button` testid, and a desktop-only `hidden sm:flex` plain "Simpan foto" button)
  // — only one is ever actually visible at a given viewport, so :visible picks whichever one
  // this test's current viewport shows, rather than hardcoding the mobile-only testid.
  await page.getByTestId("unsaved-photos-bar").locator("button:visible").filter({ hasText: "Simpan" }).click();
  const sageTile = sageGroup.getByTestId("photo-tile");
  await expect(sageTile).toHaveCount(1, { timeout: 15_000 });

  await sageTile.getByRole("button", { name: "Opsi foto" }).click();
  await page.getByRole("menuitem", { name: "Ubah teks alternatif" }).click();
  const altDialog = page.getByRole("dialog");
  await altDialog.getByLabel("Teks alternatif").fill("Gamis warna Sage tampak depan");
  await altDialog.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  return { productId, productName };
}

async function createSizeChart(page: Page, name: string): Promise<void> {
  await page.goto("/content/size-charts/new");
  await page.getByLabel("Nama size chart").fill(name);
  const rows: Array<{ size: string; bust: number; length: number; sleeve: number }> = [
    { size: "XS", bust: 86, length: 128, sleeve: 54 },
    { size: "S", bust: 90, length: 130, sleeve: 55 },
    { size: "M", bust: 94, length: 132, sleeve: 56 },
    { size: "L", bust: 98, length: 134, sleeve: 57 },
    { size: "XL", bust: 102, length: 136, sleeve: 58 },
  ];
  for (const { size, bust, length, sleeve } of rows) {
    await page.locator(`#bust-${size}`).fill(String(bust));
    await page.locator(`#length-${size}`).fill(String(length));
    await page.locator(`#sleeve-${size}`).fill(String(sleeve));
    await page.getByLabel(`Tinggi badan minimum untuk ukuran ${size}`).fill("150");
    await page.getByLabel(`Tinggi badan maksimum untuk ukuran ${size}`).fill("165");
  }
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/size-charts\/[0-9a-f-]+$/);
}

/** Writes "Gamis <b>syar'i</b> dan nyaman." as one paragraph, then a 2-item bullet list, using
 * only the toolbar buttons (>=44px touch targets per docs/plans/storefront-cms.md — no
 * keyboard-shortcut-only path is exercised here on purpose, since the plan requires every
 * formatting action to be reachable by tapping alone on iPhone/iPad Safari). */
async function writeFormattedDescription(page: Page): Promise<void> {
  const editor = page.getByTestId("storefront-description-editor");
  await editor.click();
  await page.keyboard.type("Gamis ");
  await page.getByRole("button", { name: "Tebal" }).click();
  await page.keyboard.type("syar'i");
  await page.getByRole("button", { name: "Tebal" }).click();
  await page.keyboard.type(" dan nyaman.");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Daftar bullet" }).click();
  await page.keyboard.type("Lingkar dada lega");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Tidak menerawang");
}

async function runStorefrontFlow(page: Page, label: string): Promise<void> {
  const { productId, productName } = await createPublishablePhotoReadyProduct(page, label);

  // --- Write a formatted description, save, and confirm it persists after reload. ---
  await expect(page.getByRole("heading", { name: "Storefront", exact: true })).toBeVisible();
  await writeFormattedDescription(page);
  await page.getByRole("button", { name: "Simpan storefront" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto(page.url());
  const editorAfterReload = page.getByTestId("storefront-description-editor");
  await expect(editorAfterReload.locator("strong")).toHaveText("syar'i");
  await expect(editorAfterReload.locator("li")).toHaveCount(2);
  await expect(editorAfterReload.locator("li").first()).toHaveText("Lingkar dada lega");

  // Publishing BEFORE a size chart is assigned is rejected with a friendly message, not a raw
  // server error — the "sized" product has no size_chart_id yet at this point. The component
  // itself reverts the toggle back to OFF on a failed save (nothing was actually persisted), so
  // no extra click is needed to "undo" it afterward.
  await page.getByRole("switch", { name: "Tayang di storefront" }).click();
  await page.getByRole("button", { name: "Simpan storefront" }).click();
  // Both the generic form error AND the Select's own FieldError can carry the same message —
  // `.first()` avoids a strict-mode violation from matching more than one `role="alert"`.
  await expect(page.getByRole("alert").filter({ hasText: "size chart" }).first()).toBeVisible();
  await expect(page.getByRole("switch", { name: "Tayang di storefront" })).toHaveAttribute("aria-checked", "false");

  // --- Create a size chart and assign it to this product. ---
  const chartName = `E2E Chart ${label} ${Date.now()}`;
  await createSizeChart(page, chartName);
  await page.goto(`/products/${productId}`);
  await page.locator("#size-chart-picker").selectOption({ label: chartName });

  // --- Publish toggle: now succeeds (active + size chart assigned + alt text present). ---
  await page.getByRole("switch", { name: "Tayang di storefront" }).click();
  await page.getByRole("button", { name: "Simpan storefront" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto(page.url());
  await expect(page.getByRole("switch", { name: "Tayang di storefront" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#size-chart-picker")).toHaveValue(/.+/);

  // Sanity: still the same product throughout.
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
}

test.describe("product storefront section", () => {
  test("write a formatted description, assign a size chart, and publish — at both 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runStorefrontFlow(page, "mobile");

    await page.setViewportSize({ width: 1280, height: 800 });
    await runStorefrontFlow(page, "desktop");
  });

  test("a staff user without content.manage never sees the Storefront section or /content/size-charts", async ({ page }) => {
    await loginAs(page, E2E_PRODUCTS_NO_FINANCE_EMAIL); // products.manage only, no content.manage

    await page.goto("/products");
    await page.getByRole("link", { name: new RegExp(`${E2E_PAGINATION_PRODUCT_PREFIX} 00`) }).first().click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: "Storefront" })).toHaveCount(0);

    await page.goto("/content/size-charts");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  });
});
