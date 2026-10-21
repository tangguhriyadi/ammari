import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_STOREFRONT_EMAIL, E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME } from "./global-setup";

// docs/plans/cart-checkout.md §4.5.3, session 7: a product published before "Berat kirim" became a
// publish rule stays live, and the product list badges it "Berat kirim belum diisi". /products is
// a list page, so both layouts are checked (CLAUDE.md): CardList at 390px, TableContainer at
// 1280px. The publish refusal itself is covered by storefront-section.spec.ts.

async function expectBadgeAndLiveProduct(page: Page): Promise<void> {
  await page.goto(`/products?q=${encodeURIComponent(E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME)}`);
  // Only the layout for this viewport is visible; the other one is hidden by CSS.
  const visibleRow = page
    .locator("li:visible, tr:visible")
    .filter({ has: page.getByText(E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME, { exact: true }) });
  await expect(visibleRow).toHaveCount(1);
  await expect(visibleRow.getByText("Berat kirim belum diisi", { exact: true })).toBeVisible();

  await visibleRow.getByText(E2E_UNWEIGHED_PUBLISHED_PRODUCT_NAME, { exact: true }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
  await expect(page.getByLabel("Berat kirim (gram)")).toHaveValue("");
  const section = page.getByTestId("storefront-section");
  await expect(section.getByRole("switch", { name: "Tayang di toko online" })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByTestId("storefront-needs-shipping-weight")).toContainText(
    "Berat kirim belum diisi. Produk tetap tayang",
  );
}

test("a live product without a shipping weight stays published and is badged in the list, at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_STOREFRONT_EMAIL);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectBadgeAndLiveProduct(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expectBadgeAndLiveProduct(page);
});
