import { expect, type Page } from "@playwright/test";
import sharp from "sharp";

export async function jpegFixture(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 120, g: 90, b: 90 } } }).jpeg().toBuffer();
}

/** Creates a fabric+color, an ACTIVE product with one M variant on that color, and uploads one
 * photo WITH alt text to that color — everything the required-photo invariant AND the
 * storefront publish-time alt-text check both need satisfied, so the product's publish toggle
 * (product-storefront-section) can actually succeed afterward. Returns the product's id/name. */
export async function createPublishablePhotoReadyProduct(page: Page, label: string): Promise<{ productId: string; productName: string }> {
  const unique = `${label}-${Date.now()}`;

  const fabricName = `E2E Bahan ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis E2E ${unique}`;
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

export async function createSizeChart(page: Page, name: string): Promise<void> {
  await page.goto("/content/size-charts/new");
  await page.getByLabel("Nama tabel ukuran").fill(name);
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
  await expect(page).toHaveURL(/\/content\/size-charts$/);
}

/** Full round trip: a photo-ready product (see above), a size chart assigned, and the
 * Storefront section's "Tayang di toko online" switch flipped on and saved — so the product is
 * immediately offered by the homepage tile/linked-product picker (which only offers products
 * published on the storefront, docs/plans/storefront-cms.md). Must be called while already
 * logged in as a session holding both `products.manage` and `content.manage` (e.g.
 * E2E_STOREFRONT_EMAIL, an owner-role fixture).
 *
 * `existingSizeChartName`: reuse an already-created chart (by its exact name) instead of
 * creating a fresh one — lets a test publish several products without paying the 5-row chart
 * form's cost more than once. */
export async function createAndPublishProduct(
  page: Page,
  label: string,
  existingSizeChartName?: string,
): Promise<{ productId: string; productName: string; sizeChartName: string }> {
  const { productId, productName } = await createPublishablePhotoReadyProduct(page, label);

  const chartName = existingSizeChartName ?? `E2E Chart ${label} ${Date.now()}`;
  if (!existingSizeChartName) await createSizeChart(page, chartName);
  await page.goto(`/products/${productId}`);
  await page.locator("#size-chart-picker").selectOption({ label: chartName });

  const section = page.getByTestId("storefront-section");
  await section.getByRole("switch", { name: "Tayang di toko online" }).click();
  await section.getByRole("button", { name: "Simpan" }).click();
  await page.waitForLoadState("networkidle");

  return { productId, productName, sizeChartName: chartName };
}
