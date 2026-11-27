import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_TIKTOK_ADMIN_EMAIL, E2E_TIKTOK_NO_ACCESS_EMAIL } from "./global-setup";

// Integrasi TikTok Shop (docs/plans/tiktok-shop-integration.md T2) with a stubbed TikTok:
// TIKTOK_PROVIDER=fake (playwright.config.ts) answers the token exchange and Get Authorized Shops
// inside the server, and the browser's trip to TikTok's authorize page is intercepted here and sent
// straight back to the callback with the fake's one good code. Nothing reaches TikTok. The page is
// asserted at 390px and 1280px (CLAUDE.md), each viewport running the whole connect, reconnect and
// disconnect cycle.

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;

// Values of the fake (packages/commerce/src/tiktok/fake.ts, runtime.ts).
const FAKE_SERVICE_ID = "7000000000000000000";
const FAKE_GOOD_CODE = "e2e-good-code";
const PAGE = "/settings/integrations/tiktok";

/** Stands in for TikTok's authorize page: checks the link, then "approves" with the given code. */
async function stubAuthorize(page: Page, code: string): Promise<string[]> {
  const seen: string[] = [];
  await page.route("https://services.tiktokshop.com/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.toString());
    const state = url.searchParams.get("state") ?? "";
    const callback = new URL("/api/integrations/tiktok/callback", page.url());
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    await route.fulfill({ status: 302, headers: { location: callback.toString() } });
  });
  return seen;
}

function connection(page: Page) {
  return page.getByRole("region", { name: "Koneksi" });
}

for (const viewport of VIEWPORTS) {
  test.describe(`Integrasi TikTok Shop at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("connect, reconnect, a refused code, disconnect, and every change in Log Aktivitas", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
      await page.goto(PAGE);
      await expect(page.getByRole("heading", { level: 1, name: "Integrasi TikTok Shop" })).toBeVisible();
      const section = connection(page);
      // The previous viewport's run ends disconnected; the very first run starts unconnected.
      await expect(section.getByText(/^(Belum terhubung|Diputuskan)$/)).toBeVisible();
      await expect(section.getByRole("button", { name: "Putuskan" })).toHaveCount(0);

      // Hubungkan: authorize link with the Partner Center app ID, back through the callback.
      const seen = await stubAuthorize(page, FAKE_GOOD_CODE);
      await section.getByRole("button", { name: "Hubungkan TikTok Shop" }).click();
      // The same shop disconnected by the previous viewport's run comes back as a reconnect.
      await expect(page.getByText(/^TikTok Shop terhubung(\.| ulang\. Token baru sudah disimpan\.)$/)).toBeVisible();
      const authorize = new URL(seen[0]!);
      expect(authorize.searchParams.get("service_id")).toBe(FAKE_SERVICE_ID);
      expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The callback's code and state are not left in the address bar.
      expect(new URL(page.url()).searchParams.has("code")).toBe(false);
      await expect(section.getByText("Terhubung", { exact: true })).toBeVisible();
      await expect(section.getByText("Ammari E2E", { exact: true })).toBeVisible();
      await expect(section.getByText("7000000000000000001", { exact: true })).toBeVisible();
      await expect(section.getByText("Token akses berlaku sampai")).toBeVisible();
      await expect(section.getByText("Izin berlaku sampai")).toBeVisible();
      const scopes = page.getByRole("list", { name: "Izin yang diberikan" });
      for (const label of ["Pesanan", "Keuangan", "Retur dan pengembalian dana", "Info toko", "Pengiriman", "Produk"]) {
        await expect(scopes.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByRole("region", { name: "Kesehatan sinkronisasi" }).getByText("Webhook gagal")).toBeVisible();

      // Hubungkan ulang: same shop, new tokens.
      await section.getByRole("button", { name: "Hubungkan ulang" }).click();
      await expect(page.getByText("TikTok Shop terhubung ulang. Token baru sudah disimpan.")).toBeVisible();

      // A code TikTok refuses (used or expired): the Indonesian message and the code, never TikTok's text.
      await page.unroute("https://services.tiktokshop.com/**");
      await stubAuthorize(page, "already-used-code");
      await section.getByRole("button", { name: "Hubungkan ulang" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Kode sudah dipakai, ulangi Hubungkan." })).toContainText("kode: code_rejected");
      await expect(page.getByText("auth code invalid")).toHaveCount(0);
      // Still connected with the earlier tokens.
      await expect(section.getByText("Terhubung", { exact: true })).toBeVisible();

      // A replayed or forged callback: the state is refused.
      const forged = await page.request.get(`/api/integrations/tiktok/callback?code=${FAKE_GOOD_CODE}&state=${"A".repeat(43)}`, { maxRedirects: 0 });
      expect(forged.status()).toBe(303);
      expect(forged.headers()["location"]).toBe(`${PAGE}?error=state_invalid`);
      // `next dev` can abort this navigation with a competing one of its own at 1280px (the
      // dev-server race playwright.config.ts describes); only the navigation is retried.
      await expect(async () => {
        await page.goto(forged.headers()["location"]!);
        await expect(page.getByRole("alert").filter({ hasText: "Tautan penghubung sudah dipakai" })).toContainText("kode: state_invalid", { timeout: 3_000 });
      }).toPass({ timeout: 20_000 });

      // Putuskan, after confirming.
      await section.getByRole("button", { name: "Putuskan" }).click();
      const dialog = page.getByRole("dialog", { name: "Putuskan TikTok Shop?" });
      await dialog.getByRole("button", { name: "Putuskan" }).click();
      await expect(page.getByText("TikTok Shop diputuskan. Token sudah dihapus.")).toBeVisible();
      await expect(section.getByText("Diputuskan", { exact: true })).toBeVisible();
      await expect(section.getByRole("button", { name: "Hubungkan TikTok Shop" })).toBeVisible();
      await expect(section.getByText("Token akses berlaku sampai")).toHaveCount(0);

      // Log Aktivitas, area Pengaturan.
      await page.goto("/activity-log?area=settings");
      for (const label of ["TikTok Shop dihubungkan", "TikTok Shop dihubungkan ulang", "TikTok Shop diputuskan"]) {
        await expect(page.getByText(label, { exact: true }).filter({ visible: true }).first()).toBeVisible();
      }
    });

    test("staff without integrations.manage: no menu item, 403 on the page and on the callback", async ({ page }) => {
      await loginAs(page, E2E_TIKTOK_NO_ACCESS_EMAIL);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Integrasi TikTok" })).toHaveCount(0);
      await page.goto(PAGE);
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
      const callback = await page.request.get(`/api/integrations/tiktok/callback?code=${FAKE_GOOD_CODE}&state=${"A".repeat(43)}`, { maxRedirects: 0 });
      expect(callback.status()).toBe(403);
    });
  });
}
