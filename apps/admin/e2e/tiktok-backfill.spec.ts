import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_RESERVATION_FREE_SKU,
  E2E_TIKTOK_ADMIN_EMAIL,
  E2E_TIKTOK_BF_CREATE_ID,
  E2E_TIKTOK_BF_ENRICH_ID,
  E2E_TIKTOK_BF_ENRICH_ORDER_NO,
  E2E_TIKTOK_BF_ENRICH_TYPED,
  E2E_TIKTOK_BF_LONELY_NUMBER,
  E2E_TIKTOK_BF_LONELY_ORDER_NO,
} from "./global-setup";

// docs/plans/tiktok-shop-integration.md T9, at 390px (CardList) and 1280px (TableContainer), CLAUDE.md:
//   - Pratinjau riwayat TikTok: the dry run of a fetched backfill (seeded in global-setup.ts): the
//     hand-typed order to enrich (number typed with a space, corrected on apply), the order to create,
//     and the hand-typed order TikTok never returned. Read only: "Terapkan riwayat" is never pressed;
//   - /orders/new while TikTok is connected (Q16): picking TikTok shows the warning, and it never
//     blocks saving. The shop is connected through the stubbed TikTok (TIKTOK_PROVIDER=fake, as in
//     tiktok-integration.spec.ts) and disconnected again at the end.

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

const INTEGRATION = "/settings/integrations/tiktok";

/** The layout the viewport shows: phone cards below md, the table from md up. */
function rows(section: ReturnType<Page["getByRole"]>, desktop: boolean) {
  return desktop ? section.locator("table tbody tr").filter({ visible: true }) : section.locator("ul.md\\:hidden > li").filter({ visible: true });
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
  // Unconnected, or left disconnected by tiktok-integration.spec.ts: both show "Hubungkan TikTok Shop".
  await page.getByRole("region", { name: "Koneksi" }).getByRole("button", { name: "Hubungkan TikTok Shop" }).click();
  await expect(page.getByRole("region", { name: "Koneksi" }).getByText("Terhubung", { exact: true })).toBeVisible();
}

async function disconnect(page: Page): Promise<void> {
  await page.goto(INTEGRATION);
  const section = page.getByRole("region", { name: "Koneksi" });
  // Wait for the page before deciding (a count on a page still loading reads 0).
  await expect(section.getByRole("button", { name: /^Hubungkan (TikTok Shop|ulang)$/ })).toBeVisible();
  if ((await section.getByRole("button", { name: "Putuskan" }).count()) === 0) return;
  await section.getByRole("button", { name: "Putuskan" }).click();
  await page.getByRole("dialog", { name: "Putuskan TikTok Shop?" }).getByRole("button", { name: "Putuskan" }).click();
  await expect(section.getByText("Diputuskan", { exact: true })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`TikTok backfill at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
    });

    test("the preview lists the order to enrich, the order to create and the hand-typed order TikTok never returned; nothing is applied yet", async ({ page }) => {
      await page.goto(`${INTEGRATION}/backfill`);
      await expect(page.getByRole("heading", { level: 1, name: "Pratinjau riwayat TikTok" })).toBeVisible();
      const status = page.getByTestId("tiktok-backfill-status");
      await expect(status.getByText("Siap dipratinjau", { exact: true })).toBeVisible();
      await expect(status.getByRole("button", { name: "Terapkan riwayat" })).toBeVisible();

      const enrich = page.getByRole("region", { name: /^Pesanan manual yang dilengkapi/ });
      const enrichRow = rows(enrich, desktop).filter({ hasText: E2E_TIKTOK_BF_ENRICH_ID });
      await expect(enrichRow).toHaveCount(1);
      await expect(enrichRow.getByRole("link", { name: E2E_TIKTOK_BF_ENRICH_ORDER_NO })).toBeVisible();
      await expect(enrichRow).toContainText("Dikirim menjadi Selesai");
      await expect(enrichRow).toContainText(`nomor diperbaiki (tadinya ${E2E_TIKTOK_BF_ENRICH_TYPED})`);
      await expect(enrichRow).toContainText("tanggal kirim TikTok");

      const create = page.getByRole("region", { name: /^Pesanan baru/ });
      const createRow = rows(create, desktop).filter({ hasText: E2E_TIKTOK_BF_CREATE_ID });
      await expect(createRow).toHaveCount(1);
      await expect(createRow).toContainText("Rp 259.000");

      const lonely = page.getByRole("region", { name: /^Pesanan manual yang tidak ditemukan di TikTok/ });
      const lonelyRow = rows(lonely, desktop).filter({ hasText: E2E_TIKTOK_BF_LONELY_NUMBER });
      await expect(lonelyRow).toHaveCount(1);
      await expect(lonelyRow.getByRole("link", { name: E2E_TIKTOK_BF_LONELY_ORDER_NO })).toBeVisible();

      // Still only a preview: the hand-typed order keeps its own status and number.
      await page.goto(`/orders?q=${encodeURIComponent(E2E_TIKTOK_BF_ENRICH_ORDER_NO)}`);
      await expect(page.getByText("Dikirim", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    });

    test("/orders/new warns when TikTok is picked while the shop is connected, and saving still works", async ({ page }) => {
      await connectFake(page);
      try {
        // The Integrasi page links to the preview from its Riwayat section.
        await expect(page.getByTestId("tiktok-backfill").getByRole("link", { name: "Lihat pratinjau riwayat" })).toBeVisible();

        await page.goto("/orders/new");
        await expect(page.getByTestId("tiktok-entry-notice")).toHaveCount(0);
        await page.locator("#order-channel").selectOption("tiktok");
        await expect(page.getByTestId("tiktok-entry-notice")).toContainText(/TikTok Shop (sudah terhubung|masuk otomatis)|Pesanan TikTok masuk otomatis dari TikTok Shop/);
        await page.locator("#order-channel-no").fill(`5790000000009${viewport.name}`);
        await page.locator("#order-status").selectOption("awaiting_payment");
        await page.locator(`#qty-${E2E_RESERVATION_FREE_SKU}`).fill("1");
        await page.getByRole("button", { name: "Simpan pesanan" }).click();
        await expect(page).toHaveURL(/\/orders$/, { timeout: 15_000 });
      } finally {
        await disconnect(page);
      }
    });
  });
}
