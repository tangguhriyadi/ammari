import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_INTEGRATIONS_IMPORT_EMAIL, E2E_INTEGRATIONS_ONLY_EMAIL, E2E_TIKTOK_ADMIN_EMAIL } from "./global-setup";

// Administrasi > Integrasi: one menu item, one URL per tab, at 390px (the "Lainnya" sheet) and
// 1280px (the sidebar).

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

const BASE = "/settings/integrations";
const TIKTOK = `${BASE}/tiktok`;
const SHOPEE = `${BASE}/shopee`;

/** The visible menu: the sidebar, or on a phone the "Lainnya" sheet. */
async function openMenu(page: Page, desktop: boolean) {
  if (desktop) return page.locator("#admin-sidebar");
  await page.getByRole("button", { name: "Lainnya" }).click();
  return page.getByRole("dialog");
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Tab integrasi" });
const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Navigasi breadcrumb" });

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 1024;
  test.describe(`Integrasi at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("one menu item, both tabs, browser back, the old SKU URL and the callback message", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
      await page.goto("/settings");
      const menu = await openMenu(page, desktop);
      await expect(menu.getByRole("link", { name: "Pemetaan SKU TikTok" })).toHaveCount(0);
      await menu.getByRole("link", { name: "Integrasi", exact: true }).click();

      // /settings/integrations opens the first tab.
      await expect(page).toHaveURL(new RegExp(`${TIKTOK}$`));
      await expect(page.getByRole("heading", { level: 1, name: "Integrasi" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Koneksi" })).toBeVisible();
      await expect(tabs(page).getByRole("link", { name: "TikTok Shop" })).toHaveAttribute("aria-current", "true");
      for (const crumb of ["Administrasi", "Integrasi", "TikTok Shop"]) {
        await expect(breadcrumb(page).getByText(crumb, { exact: true })).toBeVisible();
      }

      await tabs(page).getByRole("link", { name: "Shopee" }).click();
      await expect(page).toHaveURL(new RegExp(`${SHOPEE}$`));
      await expect(page.getByText("Shopee terhubung lewat impor file (Pesanan Saya), bukan API.")).toBeVisible();
      // Filled or empty, depending on which specs ran before this one.
      await expect(page.getByRole("region", { name: "Impor pesanan terakhir" })).toContainText(/\d+ disimpan, \d+ ditahan, \d+ dilewati|Belum ada impor pesanan Shopee yang disimpan\./);
      await expect(page.getByRole("link", { name: "Impor file" })).toHaveAttribute("href", "/import");
      await expect(page.getByRole("link", { name: "Daftar SKU" })).toHaveAttribute("href", "/stock/sku-list");
      await expect(breadcrumb(page).getByText("Shopee", { exact: true })).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${TIKTOK}$`));

      const old = await page.request.get(`${TIKTOK}/sku-mappings`, { maxRedirects: 0 });
      expect(old.status()).toBe(308);
      expect(old.headers()["location"]).toBe(`${TIKTOK}/sku`);
      await page.goto(`${TIKTOK}/sku-mappings`);
      await expect(page).toHaveURL(new RegExp(`${TIKTOK}/sku$`));
      await expect(page.getByRole("navigation", { name: "Bagian TikTok Shop" }).getByRole("link", { name: "Pemetaan SKU" })).toHaveAttribute("aria-current", "true");

      // Both sub-tabs fit without sideways scrolling.
      for (const name of ["Koneksi", "Pemetaan SKU"]) {
        await expect(page.getByRole("navigation", { name: "Bagian TikTok Shop" }).getByRole("link", { name })).toBeInViewport({ ratio: 1 });
      }

      await page.goto(`${TIKTOK}?connected=new`);
      await expect(page.getByText("TikTok Shop terhubung.", { exact: true })).toBeVisible();
    });

    test("without orders.import there is no Shopee tab", async ({ page }) => {
      await loginAs(page, E2E_INTEGRATIONS_ONLY_EMAIL);
      await page.goto(BASE);
      await expect(page).toHaveURL(new RegExp(`${TIKTOK}$`));
      await expect(tabs(page).getByRole("link", { name: "TikTok Shop" })).toBeVisible();
      await expect(tabs(page).getByRole("link", { name: "Shopee" })).toHaveCount(0);
      await page.goto(SHOPEE);
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });

    test("with only orders.import, Integrasi opens Shopee and hides what would be refused", async ({ page }) => {
      await loginAs(page, E2E_INTEGRATIONS_IMPORT_EMAIL);
      await page.goto(BASE);
      await expect(page).toHaveURL(new RegExp(`${SHOPEE}$`));
      await expect(tabs(page).getByRole("link", { name: "TikTok Shop" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Impor file" })).toBeVisible();
      // No stock.view: Daftar SKU would be a 403.
      await expect(page.getByRole("link", { name: "Daftar SKU" })).toHaveCount(0);
      await page.goto(TIKTOK);
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });
  });
}
