import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

test.describe("collapsible sidebar (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("collapses to an icon rail, keeps the choice across reload, and expands again", async ({ page }) => {
    await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
    await page.goto("/");

    const sidebar = page.locator("#admin-sidebar");
    const main = page.locator("main");
    const nav = sidebar.getByRole("navigation", { name: "Navigasi utama" });
    const toggle = sidebar.getByRole("button", { name: "Ciutkan menu" });

    // Expanded: 272px sidebar, content starts 32px after it.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar).toHaveCSS("width", "272px");
    const gutter = await page.locator("main > div").evaluate((el) => {
      const first = el.firstElementChild!.getBoundingClientRect().left;
      return first - document.querySelector("#admin-sidebar")!.getBoundingClientRect().right;
    });
    expect(gutter).toBe(32);
    await expect(sidebar.getByText("Operasional", { exact: true })).toBeVisible();

    // The toggle is reachable by keyboard.
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");

    const expandToggle = sidebar.getByRole("button", { name: "Lebarkan menu" });
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).toHaveCSS("width", "72px");
    await expect(main).toHaveCSS("padding-left", "72px");
    await expect(sidebar.getByText("Operasional", { exact: true })).toBeHidden();
    await expect(sidebar.getByText("AMMARI")).toBeHidden();

    // Icon-only links keep their accessible name and show a tooltip on keyboard focus.
    const orders = nav.getByRole("link", { name: "Pesanan" });
    await expect(orders).toBeVisible();
    await expect(page.getByTestId("sidebar-tooltip")).toHaveCount(0);
    await page.keyboard.press("Tab"); // toggle -> first nav link
    await page.keyboard.press("Tab");
    await orders.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(orders).toBeFocused();
    await expect(page.getByTestId("sidebar-tooltip")).toHaveText("Pesanan");

    // Active item stays clearly highlighted after navigating.
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/orders/);
    await expect(nav.getByRole("link", { name: "Pesanan" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Pesanan" })).toHaveCSS("background-color", "rgb(105, 90, 90)");

    // Reload keeps it collapsed, and the very first server render is already collapsed.
    const response = await page.reload();
    expect(await response!.text()).toContain('data-collapsed="true"');
    await expect(sidebar).toHaveCSS("width", "72px");
    await expect(sidebar.getByRole("button", { name: "Lebarkan menu" })).toBeVisible();

    // A wide table scrolls inside its own container instead of overflowing the page.
    await page.goto("/receipts");
    const pageOverflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(pageOverflows).toBe(false);

    // Expand again; that choice persists too.
    await sidebar.getByRole("button", { name: "Lebarkan menu" }).click();
    await expect(sidebar).toHaveCSS("width", "272px");
    await expect(sidebar.getByText("Operasional", { exact: true })).toBeVisible();
    await page.reload();
    await expect(sidebar).toHaveCSS("width", "272px");
    await expect(sidebar.getByRole("button", { name: "Ciutkan menu" })).toBeVisible();
  });
});

test.describe("phone navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("is unaffected by a collapsed sidebar preference", async ({ page, context, baseURL }) => {
    await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
    await context.addCookies([{ name: "ammari-admin-sidebar", value: "collapsed", url: baseURL! }]);
    await page.goto("/");

    await expect(page.locator("#admin-sidebar")).toBeHidden();
    const bottomNav = page.getByRole("navigation", { name: "Navigasi utama" });
    await expect(bottomNav.getByRole("link", { name: "Pesanan" })).toBeVisible();
    await bottomNav.getByRole("button", { name: "Lainnya" }).click();
    // Sheet links keep their visible text labels.
    const produk = page.getByRole("link", { name: "Produk", exact: true });
    await expect(produk).toBeVisible();
    await expect(produk.locator("span.sr-only")).toHaveCount(0);
    const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(horizontalScroll).toBe(false);
  });
});
