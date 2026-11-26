import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_EXPENSE_SUMMARY_MONTH,
  E2E_PRODUCTION_OUTFLOW_BATCH_NO,
  E2E_PRODUCTION_OUTFLOW_FINANCE_EMAIL,
  E2E_PRODUCTION_OUTFLOW_OWNER_EMAIL,
  E2E_PRODUCTION_OUTFLOW_PAYMENT_NOS,
  E2E_PRODUCTION_OUTFLOW_PO_NO,
} from "./global-setup";

// docs/plans/expense-master-data.md session S6: Biaya "Pengeluaran produksi" (supplier payments
// for purchases and production batches, read-only) and "Arus kas keluar" (cash flow, not profit),
// on the fixture global-setup seeds in February 2026 (see E2E_PRODUCTION_OUTFLOW_OWNER_EMAIL there).
// Each check runs at 390px (CardList) AND 1280px (TableContainer), per CLAUDE.md, and asserts the
// other layout is hidden.

interface Layout {
  label: string;
  row: string;
  hiddenRow: string;
  viewport: { width: number; height: number };
}

const MOBILE: Layout = { label: "mobile", row: '[data-testid="outflow-card"]', hiddenRow: '[data-testid="outflow-row"]', viewport: { width: 390, height: 844 } };
const DESKTOP: Layout = { label: "desktop", row: '[data-testid="outflow-row"]', hiddenRow: '[data-testid="outflow-card"]', viewport: { width: 1280, height: 800 } };

const MONTH = E2E_EXPENSE_SUMMARY_MONTH;
const PAYMENTS = E2E_PRODUCTION_OUTFLOW_PAYMENT_NOS;

async function openProductionTab(page: Page): Promise<void> {
  await page.goto(`/expenses?tab=production&month=${MONTH}`);
  await expect(page.getByRole("heading", { level: 1, name: "Biaya" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bagian Biaya" }).getByRole("link", { name: "Pengeluaran produksi" })).toHaveAttribute("aria-current", "true");
}

async function expectCashSummary(page: Page): Promise<void> {
  const summary = page.getByTestId("cash-outflow-summary");
  await expect(summary.getByRole("heading", { name: "Arus kas keluar Februari 2026" })).toBeVisible();
  await expect(summary).toContainText("Informasi arus kas, bukan laba. Laba bersih ada di tab Laba rugi.");
  // Gaji 400.000 + Sewa 200.000 (the voided Sewa never counts); the PO's DP and pelunasan plus
  // the batch payment (the voided 100.000 never counts); ads 100+100+50+30 + Endorse 150.
  await expect(summary.getByTestId("cash-operating-amount")).toHaveText("Rp 600.000");
  await expect(summary.getByTestId("cash-production-amount")).toHaveText("Rp 1.650.000");
  await expect(summary.getByTestId("cash-ads-amount")).toHaveText("Rp 430.000");
  await expect(summary.getByTestId("cash-total-amount")).toHaveText("Rp 2.680.000");
  await expect(summary).toContainText("Termasuk biaya yang dibayar dari saldo penjual Shopee/TikTok.");
  await expect(summary.getByTestId("cash-production")).toHaveAttribute("href", `/expenses?tab=production&month=${MONTH}`);
  await expect(summary.getByTestId("cash-ads")).toHaveAttribute("href", `/ads?month=${MONTH}`);
  // Neutral colours only: no olive/brick status class on any figure.
  await expect(summary.locator('[class*="success-"], [class*="danger-"]')).toHaveCount(0);
}

for (const layout of [MOBILE, DESKTOP]) {
  test.describe(`Pengeluaran produksi at ${layout.viewport.width}px (${layout.label})`, () => {
    test.use({ viewport: layout.viewport });

    test("owner: purchase DP + pelunasan and the batch payment, labelled and numbered, read-only; totals; Laba bersih unchanged", async ({ page }) => {
      await loginAs(page, E2E_PRODUCTION_OUTFLOW_OWNER_EMAIL);
      await openProductionTab(page);

      await expect(page.getByTestId("production-outflow-banner")).toHaveText(
        "Ini pembayaran untuk stok bahan dan ongkos produksi. Tidak mengurangi laba bersih lagi: biayanya masuk laporan laba rugi sebagai HPP saat barangnya terjual.",
      );
      const rows = page.locator(layout.row);
      await expect(rows).toHaveCount(3);
      await expect(page.locator(layout.hiddenRow).first()).toBeHidden();
      // Newest paid date first; the voided payment is absent.
      await expect(rows.nth(0)).toContainText(PAYMENTS.lunas);
      await expect(rows.nth(1)).toContainText(PAYMENTS.batch);
      await expect(rows.nth(2)).toContainText(PAYMENTS.dp);
      await expect(page.locator(layout.row).filter({ hasText: PAYMENTS.voided })).toHaveCount(0);

      const dp = rows.nth(2);
      await expect(dp).toContainText("Biaya produksi");
      await expect(dp).toContainText("Biaya bahan baku (Kain & aksesoris)");
      await expect(dp).toContainText("E2E Kas Toko Kain");
      await expect(dp).toContainText("Transfer");
      await expect(dp).toContainText("Rp 300.000");
      await expect(dp.getByTestId("outflow-ordinal")).toHaveText("Pembayaran ke-1");
      // The bill's CURRENT status: the PO is paid in full now.
      await expect(dp.getByTestId("payment-status-badge")).toHaveText("Lunas");
      await expect(dp.getByTestId("outflow-source-link")).toHaveText(E2E_PRODUCTION_OUTFLOW_PO_NO);
      await expect(dp.getByTestId("outflow-source-link")).toHaveAttribute("href", /^\/purchases\/[0-9a-f-]{36}$/);

      const lunas = rows.nth(0);
      await expect(lunas).toContainText("Rp 1.100.000");
      // The voided payment in between gets no number.
      await expect(lunas.getByTestId("outflow-ordinal")).toHaveText("Pembayaran ke-2");
      await expect(lunas.getByTestId("payment-status-badge")).toHaveText("Lunas");

      const batch = rows.nth(1);
      await expect(batch).toContainText(/Ongkos jahit, Finishing|Finishing, Ongkos jahit/);
      await expect(batch).toContainText("E2E Kas Penjahit");
      await expect(batch).toContainText("Rp 250.000");
      await expect(batch.getByTestId("outflow-ordinal")).toHaveText("Pembayaran ke-1");
      await expect(batch.getByTestId("payment-status-badge")).toHaveText("Lunas");
      await expect(batch.getByTestId("outflow-source-link")).toHaveText(E2E_PRODUCTION_OUTFLOW_BATCH_NO);
      await expect(batch.getByTestId("outflow-source-link")).toHaveAttribute("href", /^\/production\/[0-9a-f-]{36}$/);

      // Read-only: no record, edit or void control on any row.
      await expect(rows.getByRole("button")).toHaveCount(0);
      await expect(page.getByTestId("outflow-total")).toHaveText("Total pembayaran Februari 2026: Rp 1.650.000");

      // "Sumber" filter.
      await page.goto(`/expenses?tab=production&month=${MONTH}&source=production`);
      await expect(page.locator(layout.row)).toHaveCount(1);
      await expect(page.locator(layout.row)).toContainText(PAYMENTS.batch);

      // The cash summary on every tab of the month.
      await openProductionTab(page);
      await expectCashSummary(page);
      await page.goto(`/expenses?month=${MONTH}`);
      await expectCashSummary(page);

      // Laba rugi: Laba bersih and total biaya are the figures without any supplier payment.
      await page.goto(`/expenses?tab=pnl&period=month&month=${MONTH}`);
      await expectCashSummary(page);
      await expect(page.getByTestId("summary-expenses-value")).toHaveText("Rp 1.030.000");
      await expect(page.getByTestId("summary-net-value")).toHaveText("Rp 120.000");
      await expect(page.getByText("Biaya produksi")).toHaveCount(0);
    });

    test("Keuangan (no production.manage): the batch number is plain text, the PO still links", async ({ page }) => {
      await loginAs(page, E2E_PRODUCTION_OUTFLOW_FINANCE_EMAIL);
      await openProductionTab(page);
      const rows = page.locator(layout.row);
      await expect(rows).toHaveCount(3);
      const batch = rows.filter({ hasText: PAYMENTS.batch });
      await expect(batch.getByTestId("outflow-source-text")).toHaveText(E2E_PRODUCTION_OUTFLOW_BATCH_NO);
      await expect(batch.getByTestId("outflow-source-link")).toHaveCount(0);
      await expect(page.locator(`${layout.row} a[href^="/production/"]`)).toHaveCount(0);
      await expect(rows.filter({ hasText: PAYMENTS.dp }).getByTestId("outflow-source-link")).toHaveText(E2E_PRODUCTION_OUTFLOW_PO_NO);
      await expectCashSummary(page);
    });
  });
}
