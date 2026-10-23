import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_DISCOUNT_PRODUCT_NAME, E2E_DISCOUNT_SKU, E2E_PRODUCT_DISCOUNT_EMAIL } from "./global-setup";

// docs/plans/product-discount.md session 2: the "Diskon" section on the product page (linked Rp
// and % inputs, validation while typing, save, status chip), the base price guard against a
// stored sale price, the manual-order prefill, and the chip on /products. /products is a list
// page, so its chip is checked in both layouts (CLAUDE.md): CardList at 390px, TableContainer at
// 1280px. The audit log entry is asserted in lib/products/discount-queries.test.ts.

const BASE_PRICE_MESSAGE = "Harga normal harus lebih besar dari harga diskon (Rp 279.000) dan diskon minimal 1%. Ubah atau hapus diskon dulu.";

async function openProduct(page: Page): Promise<void> {
  await page.goto(`/products?q=${encodeURIComponent(E2E_DISCOUNT_PRODUCT_NAME)}`);
  await page.locator("li:visible, tr:visible").getByText(E2E_DISCOUNT_PRODUCT_NAME, { exact: true }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
}

async function expectListChip(page: Page, label: string): Promise<void> {
  await page.goto(`/products?q=${encodeURIComponent(E2E_DISCOUNT_PRODUCT_NAME)}`);
  // Only the layout for this viewport is visible; the other one is hidden by CSS.
  const visibleRow = page
    .locator("li:visible, tr:visible")
    .filter({ has: page.getByText(E2E_DISCOUNT_PRODUCT_NAME, { exact: true }) });
  await expect(visibleRow).toHaveCount(1);
  await expect(visibleRow.getByTestId("product-discount-chip")).toHaveText(new RegExp(`^Diskon\\s*${label}$`));
  await expect(visibleRow.getByText("Rp 279.000", { exact: true })).toBeVisible();
  await expect(visibleRow.locator("s")).toHaveText("Rp 350.000");
}

test("owner sets a discount with linked Rp/% inputs, sees the chip on the product and the list (390px and 1280px), the base price guard and the order prefill", async ({ page }) => {
  await loginAs(page, E2E_PRODUCT_DISCOUNT_EMAIL);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openProduct(page);

  const section = page.getByTestId("discount-section");
  const price = section.getByLabel("Harga setelah diskon");
  const percent = section.getByLabel("Diskon (%)");
  await expect(section.getByTestId("discount-status")).toHaveText("Nonaktif");
  await expect(section.getByTestId("discount-base-price")).toHaveText("Rp 350.000");

  // Rp -> %: the real percent, floored to one decimal (plan §3.1).
  await price.fill("279.000");
  await expect(percent).toHaveValue("20,2");

  // % -> Rp: rounded down to Rp1.000.
  await percent.fill("15");
  await expect(price).toHaveValue("297.000");

  // Validation while typing, never a crash.
  await percent.fill("150");
  await expect(section.getByText("Diskon harus 1 sampai 99 persen.")).toBeVisible();
  await price.fill("350.000");
  await expect(section.getByText("Harga setelah diskon harus lebih kecil dari harga normal.")).toBeVisible();
  await expect(percent).toHaveValue("");
  await price.fill("348.000");
  await expect(section.getByText("Diskon minimal 1%.")).toBeVisible();

  // An end before the start is refused.
  await price.fill("279.000");
  await section.getByLabel("Mulai (WIB)").fill("2030-01-02T10:00");
  await section.getByLabel("Selesai (WIB)").fill("2030-01-01T10:00");
  await expect(section.getByText("Waktu selesai harus setelah waktu mulai.")).toBeVisible();
  await section.getByLabel("Mulai (WIB)").fill("");
  await section.getByLabel("Selesai (WIB)").fill("");

  // Save an active discount.
  await section.getByRole("switch", { name: "Aktifkan diskon" }).click();
  await section.getByRole("button", { name: "Simpan diskon" }).click();
  await expect(page.getByRole("status")).toContainText("Diskon berhasil disimpan");
  await expect(section.getByTestId("discount-status")).toHaveText("Aktif");
  await page.reload();
  await expect(section.getByLabel("Harga setelah diskon")).toHaveValue("279.000");
  await expect(section.getByLabel("Diskon (%)")).toHaveValue("20,2");
  await expect(section.getByRole("switch", { name: "Aktifkan diskon" })).toHaveAttribute("aria-checked", "true");

  // The review blocker: a base price at/below the sale price is a friendly message, not a 500.
  await page.getByLabel("Harga dasar").fill("279.000");
  await page.locator("form").filter({ has: page.getByLabel("Harga dasar") }).getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.locator("#product-base-price-error")).toHaveText(BASE_PRICE_MESSAGE);
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  // The manual-order form prefills the discounted price.
  await page.goto("/orders/new");
  await page.locator(`#qty-${E2E_DISCOUNT_SKU}`).fill("1");
  await expect(page.locator(`#price-${E2E_DISCOUNT_SKU}`)).toHaveValue("279000");
  await expect(page.getByTestId(`discount-note-${E2E_DISCOUNT_SKU}`)).toHaveText("Harga diskon. Harga normal Rp 350.000.");

  // The list chip, in both layouts.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectListChip(page, "Aktif");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectListChip(page, "Aktif");

  // A future start makes it "Terjadwal"; "Hapus diskon" clears it back to "Nonaktif".
  await openProduct(page);
  await section.getByLabel("Mulai (WIB)").fill("2030-01-01T10:00");
  await section.getByRole("button", { name: "Simpan diskon" }).click();
  await expect(section.getByTestId("discount-status")).toHaveText("Terjadwal");
  await section.getByRole("button", { name: "Hapus diskon" }).click();
  await expect(section.getByTestId("discount-status")).toHaveText("Nonaktif");
  await expect(section.getByLabel("Harga setelah diskon")).toHaveValue("");
  await expect(section.getByRole("button", { name: "Hapus diskon" })).toHaveCount(0);
});
