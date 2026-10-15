import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { createPublishablePhotoReadyProduct, createSizeChart } from "./helpers/publishable-product";
import { E2E_PAGINATION_PRODUCT_PREFIX, E2E_PRODUCTS_NO_FINANCE_EMAIL, E2E_STOREFRONT_EMAIL } from "./global-setup";

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

  // Scoped to the Storefront section's own card throughout — the product EDIT page also has
  // the main ProductForm's own "Simpan" button (plain text, same as this section's), so every
  // control/button lookup below is scoped to data-testid="storefront-section" rather than the
  // whole page.
  const section = page.getByTestId("storefront-section");

  // --- Write a formatted description, save, and confirm it persists after reload. ---
  await expect(section.getByRole("heading", { name: "Toko online", exact: true })).toBeVisible();
  await writeFormattedDescription(page);
  await section.getByRole("button", { name: "Simpan" }).click();
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
  await section.getByRole("switch", { name: "Tayang di toko online" }).click();
  await section.getByRole("button", { name: "Simpan" }).click();
  // Both the generic form error AND the Select's own FieldError can carry the same message —
  // `.first()` avoids a strict-mode violation from matching more than one `role="alert"`.
  await expect(section.getByRole("alert").filter({ hasText: "tabel ukuran" }).first()).toBeVisible();
  await expect(section.getByRole("switch", { name: "Tayang di toko online" })).toHaveAttribute("aria-checked", "false");

  // --- Create a size chart and assign it to this product. ---
  const chartName = `E2E Chart ${label} ${Date.now()}`;
  await createSizeChart(page, chartName);
  await page.goto(`/products/${productId}`);
  await page.locator("#size-chart-picker").selectOption({ label: chartName });

  // --- Publish toggle: now succeeds (active + size chart assigned + alt text present). ---
  await section.getByRole("switch", { name: "Tayang di toko online" }).click();
  await section.getByRole("button", { name: "Simpan" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto(page.url());
  await expect(section.getByRole("switch", { name: "Tayang di toko online" })).toHaveAttribute("aria-checked", "true");
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

    // Searched, not just /products' default (page-1-sorted-by-name) listing — this suite's own
    // "Contoh Gamis ..." fixtures sort alphabetically before "E2E Pagination Produk" and can
    // push it past page 1 once enough of them exist across the whole run, same class of bug as
    // "Produk" vs "Produksi" elsewhere in this app's e2e.
    await page.goto(`/products?q=${encodeURIComponent(E2E_PAGINATION_PRODUCT_PREFIX)}`);
    await page.getByRole("link", { name: new RegExp(`${E2E_PAGINATION_PRODUCT_PREFIX} 00`) }).first().click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await expect(page.getByTestId("storefront-section")).toHaveCount(0);

    await page.goto("/content/size-charts");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  });
});
