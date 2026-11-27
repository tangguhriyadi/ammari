import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import { E2E_ACCOUNTING_CS_EMAIL, E2E_ACCOUNTING_EMAIL } from "./global-setup";

// docs/plans/accounting.md Session 10: Neraca, Laba rugi and Arus kas for the December 2026 trial
// month (the seeded Gaji expense and supplier payment, posted by "Posting sekarang", idempotent) at
// 390px AND 1280px (CLAUDE.md): each statement renders a stacked list on phones and a table on
// tablet/desktop, so every assertion goes through THIS viewport's rows and checks the other layout's
// row is hidden, not missing. Then the PDF and Excel downloads, the Rekonsiliasi checks 4 and 5, and
// a role without accounting.view is refused. Other accounting specs also book December, so amounts
// are not pinned here; the balance checks are.

interface Layout {
  label: string;
  row: string;
  hiddenRow: string;
  viewport: { width: number; height: number };
}

const MOBILE: Layout = { label: "mobile", row: '[data-testid="statement-card"]', hiddenRow: '[data-testid="statement-row"]', viewport: { width: 390, height: 844 } };
const DESKTOP: Layout = { label: "desktop", row: '[data-testid="statement-row"]', hiddenRow: '[data-testid="statement-card"]', viewport: { width: 1280, height: 800 } };

const DECEMBER = "from=2026-12-01&to=2026-12-31";

async function postNow(page: Page): Promise<void> {
  await page.goto(`/accounting/journal?${DECEMBER}`);
  const toasts = page.getByRole("status").filter({ hasText: "Posting selesai" });
  const before = await page.getByRole("status").getByText("Posting selesai").count();
  await page.getByRole("button", { name: "Posting sekarang" }).click();
  await expect(toasts.getByText("Posting selesai")).toHaveCount(before + 1, { timeout: 15_000 });
}

/** The row with this key in the current layout: visible; its twin in the other layout: hidden. */
async function rowFor(page: Page, layout: Layout, key: string) {
  const shown = page.locator(`${layout.row}[data-row="${key}"]`);
  await expect(shown).toHaveCount(1);
  await expect(shown).toBeVisible();
  const hidden = page.locator(`${layout.hiddenRow}[data-row="${key}"]`);
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toBeHidden();
  return shown;
}

async function checkStatements(page: Page, layout: Layout): Promise<void> {
  await page.goto("/accounting/balance-sheet?date=2026-12-31");
  await expect(page.getByRole("heading", { name: "Neraca", exact: true })).toBeVisible();
  await expect(page.getByTestId("statement-notes")).toContainText("Desember 2026 adalah bulan uji coba");
  await expect(await rowFor(page, layout, "assets:total")).toContainText("Jumlah aset");
  await expect(await rowFor(page, layout, "liabilities_equity:total")).toContainText("Jumlah kewajiban dan ekuitas");
  // The seeded Gaji expense makes a loss: the unclosed result is equity.
  await expect(await rowFor(page, layout, "equity:current_earnings")).toContainText("Laba (rugi) berjalan");
  await expect(page.getByTestId("statement-checks")).toContainText("Seimbang");

  await page.goto(`/accounting/income-statement?${DECEMBER}`);
  await expect(page.getByRole("heading", { name: "Laba Rugi" })).toBeVisible();
  const salary = await rowFor(page, layout, "6-2101");
  await expect(salary).toContainText("6-2101");
  await expect(salary).toContainText("Gaji");
  await expect(await rowFor(page, layout, "net_income")).toContainText("Laba bersih");
  await expect(page.getByTestId("statement-checks")).toContainText("Seimbang");
  // Per month: one month column plus the total.
  await page.goto(`/accounting/income-statement?${DECEMBER}&view=month`);
  const monthly = await rowFor(page, layout, "net_income");
  if (layout === MOBILE) await expect(monthly).toContainText("Des 2026");
  else await expect(page.getByRole("table", { name: "Laba rugi" }).getByRole("columnheader", { name: "Des 2026" })).toBeVisible();

  await page.goto(`/accounting/cash-flow?${DECEMBER}`);
  await expect(page.getByRole("heading", { name: "Arus Kas" })).toBeVisible();
  await expect(await rowFor(page, layout, "operating:total")).toContainText("Kas bersih dari aktivitas operasi");
  await expect(await rowFor(page, layout, "closing_cash")).toContainText("Kas dan setara kas akhir periode");
  await expect(page.getByTestId("statement-checks")).toContainText("Seimbang");
}

test("Neraca, Laba rugi and Arus kas at 390px and 1280px, with PDF and Excel downloads", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_EMAIL);
  await page.setViewportSize(DESKTOP.viewport);
  await postNow(page);
  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await checkStatements(page, layout);
    });
  }
  await test.step("downloads", async () => {
    for (const [path, fileBase] of [
      ["/accounting/balance-sheet?date=2026-12-31", "neraca-2026-12-31"],
      [`/accounting/income-statement?${DECEMBER}`, "laba-rugi-2026-12-01-2026-12-31"],
      [`/accounting/cash-flow?${DECEMBER}`, "arus-kas-2026-12-01-2026-12-31"],
    ] as const) {
      await page.goto(path);
      for (const [label, extension] of [
        ["Unduh Excel", "xlsx"],
        ["Unduh PDF", "pdf"],
      ] as const) {
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: label }).click();
        expect((await download).suggestedFilename()).toBe(`${fileBase}.${extension}`);
      }
    }
  });
});

test("Rekonsiliasi: Laba rugi vs laporan manajemen and kelengkapan posting at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_EMAIL);
  await page.setViewportSize(DESKTOP.viewport);
  await postNow(page);
  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/accounting/reconciliation?date=2026-12-31");
      await expect(page.getByRole("heading", { name: "Laba rugi dibandingkan dengan laporan manajemen" })).toBeVisible();
      await expect(page.getByTestId("reconciliation-pnl-summary")).toBeVisible();
      await expect(page.getByTestId("reconciliation-pnl-summary")).toContainText("Laba bersih buku besar");
      const expenses = page.locator('[data-testid="reconciliation-pnl-component"][data-component="operating_expenses"]');
      await expect(expenses).toBeVisible();
      await expect(expenses).toContainText("Biaya usaha (catatan Biaya)");
      await expect(page.getByRole("heading", { name: "Kelengkapan posting" })).toBeVisible();
      // Right after a posting run nothing is missing.
      await expect(page.getByTestId("reconciliation-completeness-summary")).toContainText("Belum lengkap");
      await expect(page.getByTestId("reconciliation-completeness-summary")).toContainText("Cocok");
      await expect(page.getByTestId("reconciliation-gap-card")).toHaveCount(0);
      await expect(page.getByTestId("reconciliation-gap-row")).toHaveCount(0);
    });
  }
});

test("staff without accounting.view are refused the statements and their exports", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_CS_EMAIL);
  for (const path of ["/accounting/balance-sheet", "/accounting/income-statement", "/accounting/cash-flow"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    const response = await page.request.get(`${path}/export?format=pdf`);
    expect(response.status()).toBe(403);
  }
});
