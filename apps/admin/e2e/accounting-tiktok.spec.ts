import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_ACCOUNTING_EMAIL,
  E2E_ACCOUNTING_VIEW_ONLY_EMAIL,
  E2E_TIKTOK_ADJUSTMENT_TYPE,
  E2E_TIKTOK_REKON_ORDER_NO,
  E2E_TIKTOK_REKON_PAYOUT_ID,
  E2E_TIKTOK_REKON_STATEMENT_ID,
} from "./global-setup";

// TikTok T8 (docs/plans/tiktok-shop-integration.md §5.4, §3.6) at 390px (CardList) and 1280px
// (TableContainer), CLAUDE.md's rule: Rekonsiliasi "TikTok Shop" (per order, per statement, per payout,
// the whole balance) on the December 2026 fixtures of global-setup.ts, and Pemetaan Akun's TikTok
// adjustment types (T7's seeded ads type, unmapped, 6-1101 suggested). Read only: nothing is saved, so
// both viewports and the other accounting specs see the same data whatever ran before.

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

/** This viewport's rows of a list, after checking the other layout exists but is hidden. */
async function visibleRows(section: Locator, testId: string, desktop: boolean, text: string): Promise<Locator> {
  const shown = section.getByTestId(`${testId}-${desktop ? "row" : "card"}`).filter({ hasText: text });
  const hidden = section.getByTestId(`${testId}-${desktop ? "card" : "row"}`).filter({ hasText: text });
  await expect(shown).toHaveCount(1);
  await expect(shown).toBeVisible();
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toBeHidden();
  return shown;
}

async function openReconciliation(page: Page): Promise<Locator> {
  await page.goto("/accounting/reconciliation?date=2026-12-31");
  const section = page.getByTestId("reconciliation-tiktok-section");
  await expect(section.getByRole("heading", { level: 2, name: "TikTok Shop" })).toBeVisible();
  return section;
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`TikTok accounting at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("Rekonsiliasi TikTok Shop: the order against its settlement, the statement and the payout", async ({ page }) => {
      await loginAs(page, E2E_ACCOUNTING_VIEW_ONLY_EMAIL);
      const section = await openReconciliation(page);

      await expect(section.getByTestId("reconciliation-tiktok-balance")).toContainText("Saldo Penjual TikTok seluruhnya");
      await expect(section.getByTestId("reconciliation-tiktok-balance")).toContainText("Sudah cair, belum ditarik ke bank");

      // (a) No M1 for this fixture (no stock left for it): the order's journals are 0 against 220.400.
      const order = await visibleRows(section.getByTestId("reconciliation-tiktok-orders"), "reconciliation-tiktok-order", desktop, E2E_TIKTOK_REKON_ORDER_NO);
      await expect(order).toContainText("220.400");
      await expect(order).toContainText("Tidak cocok");
      await expect(order.getByRole("link", { name: E2E_TIKTOK_REKON_ORDER_NO })).toBeVisible();

      // (b) The statement's transactions add up to its settlement.
      const statement = await visibleRows(section.getByTestId("reconciliation-tiktok-statements"), "reconciliation-tiktok-statement", desktop, E2E_TIKTOK_REKON_STATEMENT_ID);
      await expect(statement).toContainText("220.400");
      await expect(statement).toContainText("Cocok");

      // (c) The payout equals the statement it paid (journaled or not depends on whether a posting run happened).
      const payout = await visibleRows(section.getByTestId("reconciliation-tiktok-payouts"), "reconciliation-tiktok-payout", desktop, E2E_TIKTOK_REKON_PAYOUT_ID);
      await expect(payout).toContainText("220.400");
      await expect(payout).not.toContainText("Tidak cocok");

      await expect(section.getByTestId("reconciliation-tiktok-ads")).toContainText("Iklan yang mungkin tercatat dua kali");
    });

    test("Pemetaan Akun lists the TikTok adjustment type, unmapped, with 6-1101 only suggested", async ({ page }) => {
      await loginAs(page, E2E_ACCOUNTING_EMAIL);
      await page.goto("/accounting/mappings");
      await expect(page.getByRole("heading", { level: 1, name: "Pemetaan Akun" })).toBeVisible();
      const section = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Penyesuaian TikTok Shop" }) });
      await expect(section).toBeVisible();
      const row = section.locator(`[data-mapping-key="tiktok.adjustment.${E2E_TIKTOK_ADJUSTMENT_TYPE.toLowerCase()}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(E2E_TIKTOK_ADJUSTMENT_TYPE);
      await expect(row).toContainText("Belum dipetakan");
      await expect(row.getByTestId("mapping-suggestion")).toContainText("Saran: 6-1101");
      await expect(row.getByRole("combobox")).toHaveValue("6-1101");
      await expect(row.getByRole("button", { name: "Simpan" })).toBeEnabled();
      await expect(page.getByRole("status").filter({ hasText: "jenis penyesuaian TikTok belum dipetakan" })).toBeVisible();

      // The TikTok payout key sits with the methods, on Bank utama (migration 0062).
      const payoutRow = page.locator('[data-mapping-key="cash.tiktok_payout"]');
      await expect(payoutRow).toContainText("Pencairan Saldo Penjual TikTok");
      await expect(payoutRow.getByRole("combobox")).toHaveValue("1-1201");
    });

    test("a view-only accountant sees the types but no editor", async ({ page }) => {
      await loginAs(page, E2E_ACCOUNTING_VIEW_ONLY_EMAIL);
      await page.goto("/accounting/mappings");
      const row = page.locator(`[data-mapping-key="tiktok.adjustment.${E2E_TIKTOK_ADJUSTMENT_TYPE.toLowerCase()}"]`);
      await expect(row).toContainText("Belum dipetakan");
      await expect(row.getByRole("button", { name: "Simpan" })).toHaveCount(0);
    });
  });
}
