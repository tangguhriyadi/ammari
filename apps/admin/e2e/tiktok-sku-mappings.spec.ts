import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_RESERVATION_FREE_SKU, E2E_TIKTOK_ADMIN_EMAIL, E2E_TIKTOK_NO_ACCESS_EMAIL, E2E_TIKTOK_ORDER_ID, E2E_TIKTOK_SELLER_SKU, E2E_TIKTOK_SKU_ID } from "./global-setup";

// Pemetaan SKU TikTok and the dry-run preview (docs/plans/tiktok-shop-integration.md T4), at 390px
// (CardList) and 1280px (TableContainer), CLAUDE.md. global-setup.ts seeds one stored TikTok order
// whose SKU has no mapping. Each viewport maps it, sees the preview change from "Ditahan" to "Akan
// dibuat", removes the mapping again (so the other viewport starts from the same state), and reads
// both changes back in Log Aktivitas. Nothing reaches TikTok.

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

const PAGE = "/settings/integrations/tiktok/sku";
const PREVIEW = "/settings/integrations/tiktok/orders";

/** The layout the viewport shows: phone cards below md, the table from md up. */
function rows(page: Page, desktop: boolean) {
  return desktop ? page.locator("table tbody tr").filter({ visible: true }) : page.locator("ul.md\\:hidden > li").filter({ visible: true });
}

function section(page: Page, name: RegExp) {
  return page.getByRole("region", { name });
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`Pemetaan SKU TikTok at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("an unknown TikTok SKU is listed, mapped, previewed, removed, and audited", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);

      // The preview holds the order while its SKU is unmapped.
      await page.goto(PREVIEW);
      await expect(page.getByRole("heading", { level: 1, name: "Pesanan TikTok" })).toBeVisible();
      const previewRow = rows(page, desktop).filter({ hasText: E2E_TIKTOK_ORDER_ID });
      await expect(previewRow).toHaveCount(1);
      await expect(previewRow.getByText("Ditahan", { exact: true })).toBeVisible();
      await expect(previewRow.getByText(`SKU belum dipetakan: ${E2E_TIKTOK_SKU_ID}`)).toBeVisible();

      await page.goto(PAGE);
      await expect(page.getByRole("navigation", { name: "Bagian TikTok Shop" }).getByRole("link", { name: "Pemetaan SKU" })).toHaveAttribute("aria-current", "true");
      const unmapped = section(page, /^Belum dipetakan/);
      const unknownRow = rows(page, desktop).filter({ hasText: E2E_TIKTOK_SKU_ID });
      await expect(unmapped.getByText(E2E_TIKTOK_SELLER_SKU).filter({ visible: true })).toBeVisible();
      await expect(unknownRow).toHaveCount(1);

      // Cocokkan ke varian: search, pick.
      await unknownRow.getByRole("button", { name: `Cocokkan SKU TikTok ${E2E_TIKTOK_SKU_ID} ke varian` }).click();
      const dialog = page.getByRole("dialog", { name: "Cocokkan ke varian" });
      await dialog.getByLabel("Cari varian admin").fill(E2E_RESERVATION_FREE_SKU);
      await dialog.getByRole("button", { name: "Cari" }).click();
      await dialog.getByRole("button", { name: `Pilih ${E2E_RESERVATION_FREE_SKU}` }).click();
      await expect(page.getByText(`SKU TikTok dipetakan ke ${E2E_RESERVATION_FREE_SKU}.`)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(unmapped.getByText("Semua SKU TikTok sudah dipetakan")).toBeVisible();
      const mappedRow = rows(page, desktop).filter({ hasText: E2E_TIKTOK_SKU_ID });
      await expect(mappedRow.getByText(E2E_RESERVATION_FREE_SKU)).toBeVisible();
      await expect(mappedRow.getByText("Manual", { exact: true })).toBeVisible();

      // The preview now says it would be created; still nothing in admin.
      await page.goto(PREVIEW);
      await expect(rows(page, desktop).filter({ hasText: E2E_TIKTOK_ORDER_ID }).getByText("Akan dibuat", { exact: true })).toBeVisible();

      // Hapus pemetaan, after confirming: back to unmapped.
      await page.goto(PAGE);
      const again = rows(page, desktop).filter({ hasText: E2E_TIKTOK_SKU_ID });
      await again.getByRole("button", { name: `Hapus pemetaan ${E2E_TIKTOK_SKU_ID}` }).click();
      const confirm = page.getByRole("dialog", { name: "Hapus pemetaan?" });
      await confirm.getByRole("button", { name: "Hapus pemetaan" }).click();
      await expect(page.getByText("Pemetaan dihapus.")).toBeVisible();
      await expect(rows(page, desktop).filter({ hasText: E2E_TIKTOK_SKU_ID }).getByRole("button", { name: `Cocokkan SKU TikTok ${E2E_TIKTOK_SKU_ID} ke varian` })).toBeVisible();

      // Log Aktivitas, area Pengaturan.
      await page.goto("/activity-log?area=settings");
      for (const label of ["SKU TikTok dipetakan", "Pemetaan SKU TikTok dihapus"]) {
        await expect(page.getByText(label, { exact: true }).filter({ visible: true }).first()).toBeVisible();
      }
    });

    test("staff without integrations.manage: no menu item, 403 on both pages", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_NO_ACCESS_EMAIL);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Integrasi", exact: true })).toHaveCount(0);
      for (const path of [PAGE, PREVIEW]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
      }
    });
  });
}
