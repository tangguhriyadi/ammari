import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_TIKTOK_ADJUSTMENT_TYPE, E2E_TIKTOK_ADMIN_EMAIL, E2E_TIKTOK_FEE_ORDER_ID, E2E_TIKTOK_FEE_ORDER_NO, E2E_TIKTOK_NO_ACCESS_EMAIL, E2E_TIKTOK_STATEMENT_ID, E2E_TIKTOK_UNMAPPED_FEE_TYPE } from "./global-setup";

// Keuangan TikTok (docs/plans/tiktok-shop-integration.md T7), at 390px (CardList) and 1280px
// (TableContainer), CLAUDE.md. global-setup.ts seeds one order whose fees are held for an unknown fee
// type, one statement that adds up, its payout, and one adjustment type. Read only.

const PAGE = "/settings/integrations/tiktok/finance";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

function rows(section: Locator, desktop: boolean): Locator {
  return desktop ? section.locator("table tbody tr").filter({ visible: true }) : section.locator("ul.md\\:hidden > li").filter({ visible: true });
}

async function open(page: Page) {
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Keuangan TikTok" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`Keuangan TikTok at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("held fees name the unknown TikTok fee type and link the admin order", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
      await open(page);
      const held = rows(page.getByTestId("tiktok-fees-held"), desktop).filter({ hasText: E2E_TIKTOK_FEE_ORDER_ID });
      await expect(held).toHaveCount(1);
      await expect(held).toContainText("Jenis biaya TikTok belum ada di tabel biaya");
      await expect(held).toContainText(E2E_TIKTOK_UNMAPPED_FEE_TYPE);
      await expect(held.getByRole("link", { name: E2E_TIKTOK_FEE_ORDER_NO })).toBeVisible();
    });

    test("the statement adds up, the payout matches it, the adjustment type is listed by TikTok's name", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
      await open(page);
      const statement = rows(page.getByTestId("tiktok-statements"), desktop).filter({ hasText: E2E_TIKTOK_STATEMENT_ID });
      await expect(statement).toHaveCount(1);
      await expect(statement).toContainText("Rp 205.000");
      await expect(statement).toContainText("Cocok");
      await expect(statement).toContainText("Dibayar");

      const payout = rows(page.getByTestId("tiktok-payouts"), desktop).filter({ hasText: "4321" });
      await expect(payout).toHaveCount(1);
      await expect(payout).toContainText("Sama dengan laporan");

      const adjustment = rows(page.getByTestId("tiktok-adjustment-types"), desktop).filter({ hasText: E2E_TIKTOK_ADJUSTMENT_TYPE });
      await expect(adjustment).toHaveCount(1);
      await expect(adjustment).toContainText("Rp -20.000");
    });

    test("staff without integrations.manage are refused", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_NO_ACCESS_EMAIL);
      await page.goto(PAGE);
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });
  });
}
