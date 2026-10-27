import { expect, test, type Page, type Route } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

// docs/plans/admin-performance.md: a nav click must give feedback at once (the clicked item is
// highlighted before the new page arrives) and the content area must show the route's skeleton
// or the page quickly, with the sidebar/bottom nav staying mounted throughout.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

interface NavTarget {
  label: string;
  path: string;
  heading: string;
  /** Phone only: reached through the "Lainnya" sheet instead of the bottom bar. */
  viaMore?: boolean;
  /** Phone only: activated with Enter. `next dev`'s dev-tools indicator sits over the first
   * bottom-bar slot at 390px and swallows pointer clicks there (production has no indicator). */
  viaKeyboard?: boolean;
}

const DESKTOP_TARGETS: NavTarget[] = [
  { label: "Pesanan", path: "/orders", heading: "Pesanan" },
  { label: "Packing", path: "/packing", heading: "Packing" },
  { label: "Stok", path: "/stock", heading: "Stok" },
  { label: "Pembelian", path: "/purchases", heading: "Pembelian" },
  { label: "Produksi", path: "/production", heading: "Produksi" },
  { label: "Penerimaan", path: "/receipts", heading: "Penerimaan barang" },
  { label: "Produk", path: "/products", heading: "Produk" },
  { label: "Supplier", path: "/suppliers", heading: "Supplier" },
  { label: "Pelanggan & Voucher", path: "/customers", heading: "Pelanggan & Voucher" },
  { label: "Log Aktivitas", path: "/activity-log", heading: "Log Aktivitas" },
  { label: "Ringkasan", path: "/", heading: "Ringkasan" },
];

const PHONE_TARGETS: NavTarget[] = [
  { label: "Pesanan", path: "/orders", heading: "Pesanan" },
  { label: "Packing", path: "/packing", heading: "Packing" },
  { label: "Stok", path: "/stock", heading: "Stok" },
  { label: "Produk", path: "/products", heading: "Produk", viaMore: true },
  { label: "Pembelian", path: "/purchases", heading: "Pembelian", viaMore: true },
  { label: "Ringkasan", path: "/", heading: "Ringkasan", viaKeyboard: true },
];

/** The time budget for "the skeleton (or the page) appears", once the route has been compiled
 * (the e2e server is `next dev`, which compiles a route on its first visit). */
const QUICK_MS = 2_000;

const isRscNavigation = (route: Route) => route.request().headers()["rsc"] === "1";

function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Navigasi utama" });
}

async function navLink(page: Page, target: NavTarget, phone: boolean) {
  if (phone && target.viaMore) {
    await mainNav(page).getByRole("button", { name: "Lainnya" }).click();
    return page.getByRole("dialog").getByRole("link", { name: target.label, exact: true });
  }
  return mainNav(page).getByRole("link", { name: target.label, exact: true });
}

async function expectPageSettled(page: Page, target: NavTarget) {
  await expect(page).toHaveURL(new RegExp(`${target.path === "/" ? "/$" : `${target.path}$`}`));
  await expect(page.getByRole("heading", { level: 1, name: target.heading, exact: true })).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  const phone = viewport.width < 1024;
  const targets = phone ? PHONE_TARGETS : DESKTOP_TARGETS;

  test.describe(`nav loading (${viewport.width}px)`, () => {
    test.use({ viewport });

    test("each main nav click shows the skeleton or the page quickly, then the page", async ({ page }) => {
      test.setTimeout(180_000);
      await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
      // Warm-up: compile every route once so the timed clicks below measure navigation, not
      // `next dev`'s on-demand compilation.
      for (const target of targets) {
        await page.goto(target.path);
        await expectPageSettled(page, target);
      }

      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();

      for (const target of targets) {
        const link = await navLink(page, target, phone);
        if (target.viaKeyboard) await link.press("Enter");
        else await link.click();
        // The content area moves on fast: the route's skeleton, or already the page itself.
        const skeletonOrPage = page
          .locator('main [aria-busy="true"]')
          .or(page.getByRole("heading", { level: 1, name: target.heading, exact: true }));
        await expect(skeletonOrPage.first()).toBeVisible({ timeout: QUICK_MS });
        await expectPageSettled(page, target);
        // The shell stayed mounted the whole time.
        await expect(mainNav(page)).toBeVisible();
        if (!target.viaMore || !phone) {
          await expect(mainNav(page).getByRole("link", { name: target.label, exact: true })).toHaveAttribute("aria-current", "page");
        }
      }
    });

    test("the clicked item is highlighted before the new page arrives", async ({ page }) => {
      await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
      await page.goto("/orders");
      await expect(page.getByRole("heading", { level: 1, name: "Pesanan" })).toBeVisible();

      // Hold the navigation's server response, so anything that changes meanwhile is the client's
      // own optimistic state, not the new page.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(
        (url) => url.pathname === "/stock",
        async (route) => {
          if (!isRscNavigation(route)) return route.continue();
          await held;
          await route.continue();
        },
      );

      const stock = mainNav(page).getByRole("link", { name: "Stok", exact: true });
      const orders = mainNav(page).getByRole("link", { name: "Pesanan", exact: true });
      await stock.click();

      await expect(stock).toHaveAttribute("aria-current", "page", { timeout: 500 });
      await expect(orders).not.toHaveAttribute("aria-current", "page");
      // Still the old page: the highlight did not wait for the server.
      await expect(page.getByRole("heading", { level: 1, name: "Pesanan" })).toBeVisible();

      release();
      await expectPageSettled(page, { label: "Stok", path: "/stock", heading: "Stok" });
      await expect(stock).toHaveAttribute("aria-current", "page");
      await expect(orders).not.toHaveAttribute("aria-current", "page");

      // Back on the page the click came from: the old click must not light "Stok" up again.
      await page.goBack();
      await expectPageSettled(page, { label: "Pesanan", path: "/orders", heading: "Pesanan" });
      await expect(orders).toHaveAttribute("aria-current", "page");
      await expect(stock).not.toHaveAttribute("aria-current", "page");
    });
  });
}
