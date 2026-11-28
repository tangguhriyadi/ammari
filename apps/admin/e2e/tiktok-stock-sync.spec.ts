import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_TIKTOK_ADMIN_EMAIL,
  E2E_TIKTOK_NO_ACCESS_EMAIL,
  E2E_TIKTOK_STOCK_CHANGE_SKU_ID,
  E2E_TIKTOK_STOCK_HELD_SKU_ID,
  E2E_TIKTOK_STOCK_UNMAPPED_SELLER_SKU,
  E2E_TIKTOK_STOCK_UNMAPPED_SKU_ID,
} from "./global-setup";

// Integrasi > TikTok Shop > Sinkron stok (docs/plans/tiktok-stock-sync.md S1), at 390px (CardList) and
// 1280px (TableContainer), CLAUDE.md. global-setup.ts seeds three listing SKUs a read pass would have
// stored, under the fake shop's (disconnected) connection row. Each viewport connects through the
// stubbed TikTok (TIKTOK_PROVIDER=fake; the row is reused in place), reads the preview, sees the switch
// disabled while "Mulai terapkan pesanan" is off, and disconnects again. Nothing reaches TikTok, and
// nothing is pushed (S1 has no write call).

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

const INTEGRATION = "/settings/integrations/tiktok";
const PAGE = `${INTEGRATION}/stock`;

function rows(page: Page, desktop: boolean) {
  return desktop ? page.locator("table tbody tr").filter({ visible: true }) : page.locator("ul.md\\:hidden > li").filter({ visible: true });
}

async function connectFake(page: Page): Promise<void> {
  await page.route("https://services.tiktokshop.com/**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    const callback = new URL("/api/integrations/tiktok/callback", page.url());
    callback.searchParams.set("code", "e2e-good-code");
    callback.searchParams.set("state", state);
    await route.fulfill({ status: 302, headers: { location: callback.toString() } });
  });
  await page.goto(INTEGRATION);
  const section = page.getByRole("region", { name: "Koneksi" });
  await expect(section.getByRole("button", { name: /^Hubungkan (TikTok Shop|ulang)$/ })).toBeVisible();
  if ((await section.getByRole("button", { name: "Putuskan" }).count()) === 0) {
    await section.getByRole("button", { name: "Hubungkan TikTok Shop" }).click();
  }
  await expect(section.getByText("Terhubung", { exact: true })).toBeVisible();
}

async function disconnect(page: Page): Promise<void> {
  await page.goto(INTEGRATION);
  const section = page.getByRole("region", { name: "Koneksi" });
  await expect(section.getByRole("button", { name: /^Hubungkan (TikTok Shop|ulang)$/ })).toBeVisible();
  if ((await section.getByRole("button", { name: "Putuskan" }).count()) === 0) return;
  await section.getByRole("button", { name: "Putuskan" }).click();
  await page.getByRole("dialog", { name: "Putuskan TikTok Shop?" }).getByRole("button", { name: "Putuskan" }).click();
  await expect(section.getByText("Diputuskan", { exact: true })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`Sinkron stok TikTok at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("the preview shows TikTok's stock → what it would become, holds and unmapped SKUs; the switch waits for orders", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
      await connectFake(page);
      try {
        await page.goto(PAGE);
        await expect(page.getByRole("navigation", { name: "Bagian TikTok Shop" }).getByRole("link", { name: "Sinkron stok" })).toHaveAttribute("aria-current", "true");
        await expect(page.getByRole("heading", { level: 2, name: "Pratinjau per SKU" })).toBeVisible();

        // Would change: TikTok 2 → 7 (7 made, nothing held).
        const change = rows(page, desktop).filter({ hasText: E2E_TIKTOK_STOCK_CHANGE_SKU_ID });
        await expect(change).toHaveCount(1);
        await expect(change.getByText("Akan diubah", { exact: true })).toBeVisible();
        if (desktop) {
          await expect(change.locator("td").nth(3)).toHaveText("2");
          await expect(change.locator("td").nth(4)).toHaveText("7");
        } else {
          await expect(change.getByText(/Stok TikTok sekarang\s*2\s*→ akan menjadi\s*7/)).toBeVisible();
        }

        const held = rows(page, desktop).filter({ hasText: E2E_TIKTOK_STOCK_HELD_SKU_ID });
        await expect(held.getByText("Ditahan", { exact: true })).toBeVisible();
        await expect(held.getByText("Status produk di TikTok tidak bisa diubah stoknya (PLATFORM_DEACTIVATED)")).toBeVisible();

        const unmapped = rows(page, desktop).filter({ hasText: E2E_TIKTOK_STOCK_UNMAPPED_SKU_ID });
        await expect(unmapped.getByText("Belum dipetakan", { exact: true })).toBeVisible();
        await expect(unmapped.getByText(E2E_TIKTOK_STOCK_UNMAPPED_SELLER_SKU)).toBeVisible();
        await expect(unmapped.getByText("SKU penjual tidak cocok dengan SKU Ammari. Tidak disentuh")).toBeVisible();

        // Orders are not applied (the default): the switch cannot be turned on, and says why.
        const switchSection = page.getByRole("region", { name: "Sinkronkan stok ke TikTok" });
        await expect(switchSection.getByText("Belum aktif", { exact: true })).toBeVisible();
        await expect(switchSection.getByRole("button", { name: "Sinkronkan stok ke TikTok" })).toBeDisabled();
        await expect(switchSection.getByRole("button", { name: "Sinkronkan stok ke TikTok" })).toHaveAccessibleDescription(/Mulai terapkan pesanan” dulu/);

        // "Izin yang diberikan" names the product write scope when granted; the fake grants the read
        // scopes only, so the label list has no "Modifikasi produk" here.
        await page.goto(INTEGRATION);
        await expect(page.getByRole("list", { name: "Izin yang diberikan" }).getByText("Produk", { exact: true })).toBeVisible();
      } finally {
        await disconnect(page);
      }
    });

    test("staff without integrations.manage: 403", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_NO_ACCESS_EMAIL);
      await page.goto(PAGE);
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });
  });
}
