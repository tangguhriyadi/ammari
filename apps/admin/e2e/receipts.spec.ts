import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { createPurchase, createSupplier, receiveAllOutstanding } from "./helpers/purchase";
import { E2E_RECEIPTS_EMAIL } from "./global-setup";

// docs/plans/suppliers-goods-receipt.md session S7: the all-receipts list (/receipts). Runs at
// 390px AND the project's default 1280px (CLAUDE.md's rule): the list renders a CardList for
// phones and a TableContainer for desktop, so each pass asserts its own layout and that the
// other one is hidden. The fixture role has inventory.view but not production.manage.
interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile" };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop" };

async function createAccessory(page: Page, name: string): Promise<void> {
  await page.goto("/accessories/new");
  await page.locator("#accessory-name").fill(name);
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/accessories$/);
}

async function applyFilters(page: Page, filters: { supplier?: string; source?: string; status?: string }): Promise<void> {
  await page.goto("/receipts");
  if (filters.supplier) await page.getByLabel("Supplier", { exact: true }).selectOption({ label: filters.supplier });
  if (filters.source) await page.getByLabel("Sumber").selectOption({ label: filters.source });
  if (filters.status) await page.getByLabel("Status").selectOption({ label: filters.status });
  await page.getByRole("button", { name: "Terapkan" }).click();
  await expect(page).toHaveURL(/\/receipts\?/);
}

async function runReceiptsFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const supplierName = `E2E Supplier Penerimaan ${marker}`;
  const accessoryName = `E2E Kancing Penerimaan ${marker}`;
  await createSupplier(page, supplierName);
  await createAccessory(page, accessoryName);

  // Three receipts on one purchase: received, reversed (its reversal is the third), received again.
  await createPurchase(page, supplierName, [{ type: "Aksesoris", itemName: accessoryName, qty: "3", amount: "3.000" }]);
  const purchaseUrl = page.url();
  await receiveAllOutstanding(page);
  await page.getByTestId("receipt-row").first().getByRole("button", { name: /Batalkan penerimaan/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Batalkan penerimaan" }).click();
  await expect(page.getByTestId("receipt-row")).toHaveCount(2, { timeout: 15_000 });
  await receiveAllOutstanding(page);

  // Filtered to this supplier: all three, in this viewport's layout only.
  await applyFilters(page, { supplier: supplierName });
  const rows = page.locator(layout.rowTag).filter({ hasText: supplierName });
  await expect(rows).toHaveCount(3);
  await expect(page.locator(layout.hiddenRowTag).filter({ hasText: supplierName }).first()).toBeHidden();
  await expect(rows.filter({ hasText: "Diterima" })).not.toHaveCount(0);
  await expect(rows.filter({ hasText: "Dibatalkan" })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Pembatalan GR-\d{6}-\d{3}/ })).toHaveCount(1);

  // Status filter keeps the supplier filter.
  await applyFilters(page, { supplier: supplierName, status: "Dibatalkan" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Dibatalkan");

  // Source filter: this supplier has no production receipts.
  await applyFilters(page, { supplier: supplierName, source: "Produksi" });
  await expect(page.getByText("Tidak ada penerimaan yang cocok")).toBeVisible();
  await page.getByRole("link", { name: "Reset" }).click();
  await expect(page).toHaveURL(/\/receipts$/);

  // Date filter: a range long before any of these receipts shows none of them.
  await applyFilters(page, { supplier: supplierName });
  const supplierParam = new URL(page.url()).searchParams.get("supplier");
  await page.goto(`/receipts?supplier=${supplierParam}&from=2000-01-01&to=2000-01-31`);
  await expect(page.getByLabel("Dari tanggal")).toHaveValue("2000-01-01");
  await expect(page.getByText("Tidak ada penerimaan yang cocok")).toBeVisible();

  // The source link opens the purchase document.
  await page.goto(`/receipts?supplier=${supplierParam}&status=active`);
  await rows.first().getByRole("link", { name: /^PO-\d{6}-\d{3}$/ }).click();
  await expect(page).toHaveURL(purchaseUrl);
}

test.describe("Penerimaan: daftar semua penerimaan", () => {
  test("filters by supplier, status, source and date, and links back to the purchase, at 390px and 1280px", async ({ page }) => {
    test.setTimeout(180_000);
    await loginAs(page, E2E_RECEIPTS_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runReceiptsFlow(page, MOBILE);

    await page.setViewportSize({ width: 1280, height: 800 });
    await runReceiptsFlow(page, DESKTOP);
    // The menu entry, under Operasional, for an inventory.view session.
    await expect(page.getByRole("navigation").getByRole("link", { name: "Penerimaan" })).toBeVisible();
  });
});
