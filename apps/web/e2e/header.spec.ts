import { expect, test, type Locator, type Page } from "@playwright/test";
import { animatedBetween, readCurtainLog, recordCurtain } from "./helpers/curtain";
import { CART_E2E } from "./helpers/cart-flag";

// docs/design/storefront.md §4 "Header": desktop is wordmark left, account right, nothing in the
// center (the old center "Koleksi" nav link is gone); mobile is unchanged (menu left, centered
// wordmark, account right, Koleksi inside the menu).
test.describe("header", () => {
  test("desktop (1280px): no center nav, wordmark at the left gutter, account at the right gutter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const header = page.locator("header");

    await expect(header.getByRole("navigation")).toHaveCount(0);
    await expect(header.getByRole("link", { name: /koleksi/i })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Buka menu" })).toBeHidden();

    const logo = header.getByRole("link", { name: "Ammari, beranda" }).locator("visible=true");
    await expect(logo).toHaveCount(1);
    const account = header.getByRole("link", { name: "Akun saya" });
    const logoBox = (await logo.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    // 40px desktop gutter on both sides (Container), so the two ends mirror each other. With the
    // cart on, the bag sits at the right edge and the account icon right before it.
    const rightmostBox = CART_E2E ? (await header.getByRole("link", { name: /^Keranjang/ }).boundingBox())! : accountBox;
    expect(logoBox.x).toBe(40);
    expect(1280 - (rightmostBox.x + rightmostBox.width)).toBe(40);
    if (CART_E2E) expect(accountBox.x + accountBox.width).toBeLessThanOrEqual(rightmostBox.x);
    // Both vertically centred in the 56px header.
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.height).toBe(56);
    expect(Math.abs(logoBox.y + logoBox.height / 2 - (headerBox.y + 28))).toBeLessThanOrEqual(1);
    expect(Math.abs(accountBox.y + accountBox.height / 2 - (headerBox.y + 28))).toBeLessThanOrEqual(1);
  });

  test("mobile (390px): unchanged, menu button left, centred wordmark, Koleksi in the menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const header = page.locator("header");

    const logo = header.getByRole("link", { name: "Ammari, beranda" }).locator("visible=true");
    const logoBox = (await logo.boundingBox())!;
    expect(Math.abs(logoBox.x + logoBox.width / 2 - 195)).toBeLessThanOrEqual(1);

    await header.getByRole("button", { name: "Buka menu" }).click();
    await expect(header.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Koleksi" })).toBeVisible();
  });
});

// components/curtain.tsx: the menu unrolls from under the header and rolls back up, and every way
// of closing it plays that animation before the panel is removed.
test.describe("mobile menu curtain (390px)", () => {
  async function setup(page: Page) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const toggle = page.locator("header button[aria-controls]");
    await recordCurtain(toggle);
    return toggle;
  }

  function panelOf(page: Page) {
    return page.locator("header [data-state]");
  }

  async function expectRolledUp(page: Page, toggle: Locator) {
    await expect(panelOf(page)).toHaveCount(0);
    const { states } = await readCurtainLog(toggle);
    // The closing state was rendered before the removal.
    expect(states.slice(-2)).toEqual(["closing", "removed"]);
  }

  test("opens top to bottom with real intermediate heights, closes back up via the toggle", async ({ page }) => {
    const toggle = await setup(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panelOf(page)).toHaveAttribute("data-state", "open");

    const opened = await readCurtainLog(toggle);
    expect(opened.states).toEqual(["removed", "entering", "opening", "open"]);
    const panelBox = (await panelOf(page).boundingBox())!;
    // Hangs from the header's bottom edge.
    const headerBox = (await page.locator("header").boundingBox())!;
    expect(Math.abs(panelBox.y - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(1);
    expect(animatedBetween(opened.heights, panelBox.height)).toBe(true);
    await expect(page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Koleksi" })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expectRolledUp(page, toggle);
    const closed = await readCurtainLog(toggle);
    expect(animatedBetween(closed.heights.slice(opened.heights.length), panelBox.height)).toBe(true);
  });

  test("Escape rolls it up and returns focus to the toggle", async ({ page }) => {
    const toggle = await setup(page);
    await toggle.click();
    await expect(panelOf(page)).toHaveAttribute("data-state", "open");
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expectRolledUp(page, toggle);
  });

  test("a same-page link inside the menu rolls it up", async ({ page }) => {
    const toggle = await setup(page);
    await toggle.click();
    await expect(panelOf(page)).toHaveAttribute("data-state", "open");
    await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Koleksi" }).click();
    await expectRolledUp(page, toggle);
  });

  test("navigating to another page through the menu leaves it closed", async ({ page }) => {
    const toggle = await setup(page);
    await toggle.click();
    await expect(panelOf(page)).toHaveAttribute("data-state", "open");
    await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Syarat & Ketentuan" }).click();
    await expect(page).toHaveURL(/\/terms-of-service$/);
    await expect(page.locator("header button[aria-controls]")).toHaveAttribute("aria-expanded", "false");
    await expect(panelOf(page)).toHaveCount(0);
  });

  test("prefers-reduced-motion: opens and closes instantly", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const toggle = await setup(page);
    await toggle.click();
    await expect(panelOf(page)).toHaveAttribute("data-state", "open");
    await toggle.click();
    await expect(panelOf(page)).toHaveCount(0);
    const { states } = await readCurtainLog(toggle);
    expect(states).toEqual(["removed", "open", "removed"]);
  });
});
