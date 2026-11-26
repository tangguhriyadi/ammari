import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { E2E_ADS_EMAIL, E2E_EXPENSE_SUMMARY_MONTH } from "./global-setup";

// docs/plans/expense-master-data.md session S5: the "Iklan" menu (/ads). Ad and endorse expenses
// only (owner answer D7), recorded with "Catat iklan", and the "ROAS" tab, whose figures for the
// seeded month (global-setup.ts E2E_EXPENSE_SUMMARY_MONTH) are exactly the old Iklan & Biaya
// Ringkasan's. Every test runs at 390px AND 1280px (CLAUDE.md): the lists render a CardList on
// phones and a TableContainer from md up, so each pass asserts its own layout's rows and that the
// other layout's are hidden.

interface Layout {
  label: string;
  viewport: { width: number; height: number };
  row: string;
  hiddenRow: string;
  roas: string;
  hiddenRoas: string;
}

const LAYOUTS: readonly Layout[] = [
  { label: "390px", viewport: { width: 390, height: 844 }, row: "expense-card", hiddenRow: "expense-row", roas: "summary-roas-card", hiddenRoas: "summary-roas-row" },
  { label: "1280px", viewport: { width: 1280, height: 800 }, row: "expense-row", hiddenRow: "expense-card", roas: "summary-roas-row", hiddenRoas: "summary-roas-card" },
];

async function receiptPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 180, g: 190, b: 200 } } })
    .jpeg()
    .toBuffer();
}

async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const layout of LAYOUTS) {
  test.describe(`Iklan at ${layout.label}`, () => {
    test.use({ viewport: layout.viewport });

    test("ad and endorse rows only, Kanal filter, record an ad with Catat iklan, ROAS tab equals the seeded month", async ({ page }) => {
      test.setTimeout(150_000);
      await loginAs(page, E2E_ADS_EMAIL);
      const rows = page.getByTestId(layout.row);

      // 1. The seeded month: the five ad and endorse rows (280.000 ads + 150.000 endorse), no Gaji
      // or Sewa; the pickers offer ad and endorse categories only.
      await page.goto(`/ads?month=${E2E_EXPENSE_SUMMARY_MONTH}`);
      await expect(page.getByRole("heading", { level: 1, name: "Iklan" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Bagian Iklan" }).getByRole("link", { name: "Catatan iklan" })).toHaveAttribute("aria-current", "true");
      await expect(rows).toHaveCount(5);
      await expect(rows.filter({ hasText: "Endorse/KOL" })).toContainText("Rp 150.000");
      await expect(rows.filter({ hasText: /Gaji|Sewa/ })).toHaveCount(0);
      await expect(page.getByTestId(layout.hiddenRow).first()).toBeHidden();
      await expect(page.getByTestId("expense-total")).toContainText("Rp 430.000");
      const filterOptions = page.locator("#expense-filter-category option");
      await expect(filterOptions.filter({ hasText: "Iklan Meta" })).toHaveCount(1);
      await expect(filterOptions.filter({ hasText: "Endorse/KOL" })).toHaveCount(1);
      await expect(filterOptions.filter({ hasText: /Gaji|Sewa|Lainnya/ })).toHaveCount(0);

      // Kanal: only rows tagged with it.
      await page.getByLabel("Kanal").selectOption("shopee");
      await page.getByRole("button", { name: "Terapkan" }).click();
      // A GET form also sends its empty fields (category=, q=).
      await expect(page).toHaveURL(new RegExp(`/ads\\?month=${E2E_EXPENSE_SUMMARY_MONTH}&.*channel=shopee`));
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Iklan Shopee");
      await expect(page.getByTestId("expense-total")).toContainText("Rp 100.000");
      await expectNoHorizontalScroll(page);

      // 2. Catat iklan: ad and endorse categories under "Iklan" only; Iklan Shopee is fixed to Shopee.
      const marker = `E2E-ads-${layout.label}-${Date.now()}`;
      await page.goto(`/ads?q=${encodeURIComponent(marker)}`);
      await expect(page.getByText("Belum ada biaya iklan", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Catat iklan" }).click();
      const dialog = page.getByRole("dialog", { name: "Catat iklan" });
      await expect(dialog).toBeVisible();
      const category = dialog.getByLabel("Kategori");
      await expect(category.locator("optgroup")).toHaveAttribute("label", "Iklan");
      await expect(category.locator("option").filter({ hasText: "Endorse/KOL" })).toHaveCount(1);
      await expect(category.locator("option").filter({ hasText: /Gaji|Sewa|Packaging|Lainnya/ })).toHaveCount(0);
      await category.selectOption("ads_shopee");
      await expect(dialog.getByLabel("Kanal")).toBeDisabled();
      await expect(dialog.getByLabel("Kanal")).toHaveValue("shopee");
      await expect(dialog.getByLabel("Metode")).toHaveValue("platform_balance");
      await dialog.getByLabel("Jumlah").fill("750.000");
      await dialog.getByLabel("Kampanye").fill(marker);
      await dialog.locator('input[type="file"]').setInputFiles({ name: `iklan-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto() });
      await expect(dialog.getByTestId("private-file-selected")).toContainText(`iklan-${marker}.jpg`);
      await dialog.getByRole("button", { name: "Simpan iklan" }).click();
      await expect(page.getByRole("status")).toContainText(/Biaya BYA-\d{6}-\d{3} dicatat\./, { timeout: 15_000 });
      await expect(dialog).toBeHidden();
      const row = rows.filter({ hasText: marker });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Iklan Shopee");
      await expect(row).toContainText("Shopee");
      await expect(row).toContainText("Rp 750.000");
      await expect(row).toContainText("Saldo platform");
      await expect(page.getByTestId("expense-total")).toContainText("Rp 750.000");

      // ...and it is not on Biaya.
      await page.goto(`/expenses?q=${encodeURIComponent(marker)}`);
      await expect(page.getByText("Belum ada biaya", { exact: true })).toBeVisible();

      // 3. ROAS: the tab opens this month; the seeded month shows the old Ringkasan figures
      // (Titik impas 2.000.000 / (1.170.000 - 20.000) = 1,7, HPP/fees incomplete so flagged).
      await page.goto("/ads");
      await page.getByRole("navigation", { name: "Bagian Iklan" }).getByRole("link", { name: "ROAS" }).click();
      await expect(page).toHaveURL(/\/ads\?tab=roas$/);
      await expect(page.getByRole("navigation", { name: "Pilih periode" }).getByRole("link", { name: "Bulan ini" })).toHaveAttribute("aria-current", "true");
      await page.getByRole("navigation", { name: "Pilih periode" }).getByRole("link", { name: "Pilih bulan" }).click();
      await expect(page).toHaveURL(/\/ads\?tab=roas&period=month$/);
      await page.getByLabel("Bulan", { exact: true }).fill(E2E_EXPENSE_SUMMARY_MONTH);
      await page.getByRole("button", { name: "Tampilkan" }).click();
      await expect(page).toHaveURL(new RegExp(`/ads\\?tab=roas&period=month&month=${E2E_EXPENSE_SUMMARY_MONTH}`));
      await expect(page.getByTestId("summary-period")).toHaveText("Februari 2026");

      await expect(page.getByTestId("summary-marketing-total")).toContainText("Biaya pemasaran Rp 430.000");
      await expect(page.getByTestId("summary-endorsement")).toContainText("Biaya endorse Rp 150.000");
      await expect(page.getByTestId("summary-break-even-value")).toHaveText("1,7 (margin kontribusi 57,5%)");
      await expect(page.getByTestId("summary-break-even")).toContainText("titik impas sebenarnya lebih tinggi");
      await expect(page.getByTestId("summary-break-even")).toContainText("1 dibagi 12%");
      const roas = (key: string) => page.locator(`[data-testid="${layout.roas}"][data-channel="${key}"]`);
      await expect(page.getByTestId(layout.roas)).toHaveCount(7);
      await expect(roas("shopee")).toContainText("Rp 100.000");
      await expect(roas("shopee")).toContainText("Rp 1.000.000");
      await expect(roas("shopee")).toContainText("10,0");
      await expect(roas("shopee")).toContainText("Di atas titik impas");
      await expect(roas("tiktok")).toContainText("5,0");
      await expect(roas("tiktok")).toContainText("Di atas titik impas");
      await expect(roas("web")).toContainText("Situs");
      await expect(roas("web")).toContainText("6,0 (perkiraan)");
      await expect(roas("instagram")).toContainText("Belum ada iklan");
      await expect(roas("whatsapp")).toContainText("Rp 200.000");
      await expect(roas("whatsapp")).toContainText("Belum ada iklan");
      await expect(roas("untagged")).toContainText("Tanpa kanal");
      await expect(roas("untagged")).toContainText("Rp 30.000");
      await expect(roas("total")).toContainText("Rp 280.000");
      await expect(roas("total")).toContainText("Rp 2.000.000");
      await expect(roas("total")).toContainText("7,1 (perkiraan)");
      await expect(roas("total")).toContainText("Di atas titik impas");
      await expect(page.getByTestId(layout.hiddenRoas).first()).toBeHidden();
      // Laba bersih and the monthly report live on Biaya (D8), linked from here.
      await expect(page.getByTestId("summary-net-value")).toHaveCount(0);
      await expect(page.getByTestId("summary-download-pdf")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Biaya, tab Laba rugi" })).toHaveAttribute("href", `/expenses?tab=pnl&period=month&month=${E2E_EXPENSE_SUMMARY_MONTH}`);
      await expectNoHorizontalScroll(page);
    });
  });
}
