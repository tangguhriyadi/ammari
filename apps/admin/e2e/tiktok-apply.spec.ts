import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_TIKTOK_ADMIN_EMAIL, E2E_TIKTOK_BUYER_MESSAGE, E2E_TIKTOK_READY_ORDER_NO, E2E_TIKTOK_WAITING_ORDER_NO } from "./global-setup";

// TikTok orders applied by the sync (docs/plans/tiktok-shop-integration.md T5), at 390px (CardList)
// and 1280px (TableContainer), CLAUDE.md. global-setup.ts seeds two applied TikTok orders: one paid
// minutes ago (the buyer can still cancel: not packable, "Tunggu TikTok") and one paid hours ago
// (packable). Read only: nothing is shipped or changed, so both viewports see the same state.

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

/** The layout the viewport shows: phone cards below md, the table from md up. */
function rows(page: Page, desktop: boolean) {
  return desktop ? page.locator("table tbody tr").filter({ visible: true }) : page.locator("ul.md\\:hidden > li").filter({ visible: true });
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`TikTok orders in admin at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
    });

    test("the order list shows the TikTok wait badge only on the order still in its cancel window", async ({ page }) => {
      await page.goto(`/orders?q=${encodeURIComponent("ORD-E2E-TIKTOK")}`);
      const waiting = rows(page, desktop).filter({ hasText: E2E_TIKTOK_WAITING_ORDER_NO });
      const ready = rows(page, desktop).filter({ hasText: E2E_TIKTOK_READY_ORDER_NO });
      await expect(waiting).toHaveCount(1);
      await expect(ready).toHaveCount(1);
      await expect(waiting.getByTestId("tiktok-on-hold-badge")).toHaveText("Tunggu TikTok");
      // Waiting is not something staff act on: no "Perlu dicek" for it.
      await expect(waiting.getByText("Perlu dicek", { exact: true })).toHaveCount(0);
      await expect(ready.getByTestId("tiktok-on-hold-badge")).toHaveCount(0);
      await expect(waiting.getByText("Siap Kirim", { exact: true })).toBeVisible();
    });

    test("packing shows the gate and the buyer message; only the packable order can be selected and shipped", async ({ page }) => {
      await page.goto("/packing?channel=tiktok");
      const waiting = rows(page, desktop).filter({ hasText: E2E_TIKTOK_WAITING_ORDER_NO });
      const ready = rows(page, desktop).filter({ hasText: E2E_TIKTOK_READY_ORDER_NO });
      await expect(waiting).toHaveCount(1);
      await expect(ready).toHaveCount(1);

      await expect(waiting.getByTestId("tiktok-packing-badge")).toHaveText(/^Tunggu: pembeli masih bisa membatalkan \(sampai \d{2}\.\d{2}\)$/);
      await expect(waiting.getByTestId("packing-buyer-message")).toContainText(E2E_TIKTOK_BUYER_MESSAGE);
      await expect(waiting.getByRole("checkbox")).toBeDisabled();
      await expect(waiting.getByRole("button", { name: "Tandai dikirim" })).toHaveCount(0);

      await expect(ready.getByTestId("tiktok-packing-badge")).toHaveText("Siap dikemas");
      await expect(ready.getByTestId("packing-buyer-message")).toContainText(E2E_TIKTOK_BUYER_MESSAGE);
      await expect(ready.getByRole("checkbox")).toBeEnabled();
      await expect(ready.getByRole("button", { name: "Tandai dikirim" })).toBeVisible();
    });

    test("the order page shows the TikTok section with the packing state and the buyer message", async ({ page }) => {
      await page.goto(`/orders?q=${encodeURIComponent(E2E_TIKTOK_WAITING_ORDER_NO)}`);
      await rows(page, desktop).filter({ hasText: E2E_TIKTOK_WAITING_ORDER_NO }).getByRole("link").first().click();
      await expect(page.getByRole("heading", { level: 1, name: E2E_TIKTOK_WAITING_ORDER_NO })).toBeVisible();
      const section = page.getByTestId("marketplace-section");
      await expect(section.getByText("Terakhir diperbarui dari TikTok Shop")).toBeVisible();
      await expect(section.getByTestId("tiktok-packing-badge")).toContainText("Tunggu");
      await expect(section.getByTestId("tiktok-buyer-message")).toHaveText(E2E_TIKTOK_BUYER_MESSAGE);
    });
  });
}
