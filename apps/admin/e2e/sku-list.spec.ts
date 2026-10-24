import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_RESERVATION_FREE_SKU, E2E_RESERVATION_HELD_SKU, E2E_RESERVATION_PRODUCT_NAME, E2E_SKU_LIST_EMAIL } from "./global-setup";

// Daftar SKU (docs/plans/marketplace-import.md §11.1): a list page, so asserted at 390px (CardList)
// AND at the project's default 1280px (TableContainer), CLAUDE.md. Reads the product global-setup
// seeds for the reservation spec (M: 5 pcs, L: 3 pcs, colour Mocca); it changes nothing.

interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
  width: number;
  height: number;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile", width: 390, height: 844 };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop", width: 1280, height: 800 };

async function visibleRow(page: Page, layout: Layout, sku: string) {
  const row = page.locator(layout.rowTag).filter({ hasText: sku });
  await expect(row).toBeVisible();
  await expect(page.locator(layout.hiddenRowTag).filter({ hasText: sku }).first()).toBeHidden();
  return row;
}

for (const layout of [MOBILE, DESKTOP]) {
  test(`Daftar SKU: search, rows, CSV and copy (${layout.label})`, async ({ page, context }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loginAs(page, E2E_SKU_LIST_EMAIL);

    // Reached from the Stok page.
    await page.goto("/stock");
    await page.getByRole("link", { name: "Daftar SKU" }).click();
    await expect(page).toHaveURL(/\/stock\/sku-list$/);
    await expect(page.getByRole("heading", { name: "Daftar SKU" })).toBeVisible();

    await page.getByLabel("Cari SKU").fill("E2E-DIPESAN");
    await page.getByRole("button", { name: "Cari" }).click();
    await expect(page).toHaveURL(/q=E2E-DIPESAN/);
    await expect(page.getByTestId("sku-list-count")).toHaveText("2 SKU");

    const medium = await visibleRow(page, layout, E2E_RESERVATION_HELD_SKU);
    await expect(medium).toContainText(E2E_RESERVATION_PRODUCT_NAME);
    await expect(medium).toContainText("Mocca");
    await expect(medium).toContainText("5");
    const large = await visibleRow(page, layout, E2E_RESERVATION_FREE_SKU);
    await expect(large).toContainText("3");

    // Unduh CSV: the same two rows, filtered like the page.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Unduh CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^daftar-sku-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = (await readFile(await download.path())).toString("utf8");
    expect(csv).toBe(
      `\ufeffProduk,Warna,Ukuran,SKU,Status,Stok\r\n${E2E_RESERVATION_PRODUCT_NAME},Mocca,M,${E2E_RESERVATION_HELD_SKU},Aktif,5\r\n${E2E_RESERVATION_PRODUCT_NAME},Mocca,L,${E2E_RESERVATION_FREE_SKU},Aktif,3\r\n`,
    );

    // Salin SKU: one SKU per line, in list order.
    await page.getByRole("button", { name: "Salin SKU" }).click();
    await expect(page.getByRole("button", { name: "SKU tersalin" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${E2E_RESERVATION_HELD_SKU}\n${E2E_RESERVATION_FREE_SKU}\n`);

    // The Nonaktif filter (with the same search) hides them: both are active.
    await page.goto("/stock/sku-list?q=E2E-DIPESAN&status=inactive");
    await expect(page.getByText("Tidak ada SKU yang cocok")).toBeVisible();
  });
}
