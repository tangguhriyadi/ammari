import { expect, test, type Page } from "@playwright/test";
import { E2E_PRODUCT_SLUG } from "./storefront-fixtures";
import { E2E_STOREFRONT_SETTINGS_DEFAULTS, setStorefrontSettings } from "./helpers/store-settings-db";

// docs/design/storefront.md §4 "Announcement bar": full width, brand background, white text,
// 36px on phones and 40px on desktop, NOT sticky (it scrolls away) while the header stays sticky
// with no jump, and nothing at all when switched off or empty. Asserted at 390px and at the
// Playwright desktop default 1280px.

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844, barHeight: 36 },
  { name: "1280px", width: 1280, height: 900, barHeight: 40 },
] as const;

const DEFAULT_TEXT = "Gratis Ongkir Ke Seluruh Indonesia";

async function top(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top);
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((target) => window.scrollTo({ top: target, behavior: "instant" }), y);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
}

test.describe("announcement bar", () => {
  test.afterEach(async () => {
    await setStorefrontSettings(E2E_STOREFRONT_SETTINGS_DEFAULTS);
  });

  for (const viewport of VIEWPORTS) {
    test(`renders above the header on every page type, one line, ${viewport.barHeight}px tall, brand colours (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const path of ["/", `/products/${E2E_PRODUCT_SLUG}`, "/shipping", "/halaman-yang-tidak-ada"]) {
        await page.goto(path);
        const bar = page.getByRole("region", { name: "Pengumuman" });
        await expect(bar).toHaveText(DEFAULT_TEXT, { ignoreCase: true });
        const box = (await bar.boundingBox())!;
        expect(box.y).toBe(0);
        expect(box.height).toBe(viewport.barHeight);
        expect(box.width).toBe(viewport.width);
        // The header starts exactly where the bar ends: no gap, no overlap.
        expect(await top(page, "header")).toBe(viewport.barHeight);
      }

      const bar = page.getByRole("region", { name: "Pengumuman" });
      const styles = await bar.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, position: style.position };
      });
      expect(styles).toEqual({ background: "rgb(105, 90, 90)", color: "rgb(255, 255, 255)", position: "static" });

      // One line, not truncated: the default text fits.
      const text = bar.locator("p");
      const fit = await text.evaluate((element) => ({
        overflowing: element.scrollWidth > element.clientWidth,
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
      }));
      expect(fit).toEqual({ overflowing: false, lines: 1 });
    });

    test(`scrolls away while the header stays sticky, with no jump (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      const barHeight: number = viewport.barHeight;

      // Part-way: the header follows the bar up, still flush with its bottom edge.
      await scrollTo(page, 20);
      expect(await top(page, "[data-testid=announcement-bar]")).toBe(-20);
      expect(await top(page, "header")).toBe(barHeight - 20);

      // Past the bar: the bar is gone off-screen, the header is pinned at the very top.
      for (const y of [barHeight, barHeight + 1, 600]) {
        await scrollTo(page, y);
        expect(await top(page, "header")).toBe(0);
      }
      expect(await top(page, "[data-testid=announcement-bar]")).toBe(-600);
      await expect(page.getByRole("region", { name: "Pengumuman" })).not.toBeInViewport();
      await expect(page.locator("header")).toBeInViewport();
    });

    test(`"Panduan ukuran" lands the size chart below the sticky header, with the bar on (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      await page.getByRole("link", { name: "Panduan ukuran" }).click();
      const heading = page.getByRole("heading", { name: "Panduan ukuran" });
      await expect(heading).toBeFocused();
      await expect
        .poll(async () => {
          const headerBottom = await page.locator("header").evaluate((element) => element.getBoundingClientRect().bottom);
          const headingTop = await heading.evaluate((element) => element.getBoundingClientRect().top);
          return headingTop >= headerBottom;
        })
        .toBe(true);
      await expect(heading).toBeInViewport();
    });

    test(`switched off, or empty, renders nothing and leaves no gap (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await setStorefrontSettings({ announcementBarEnabled: false });
      await page.goto("/");
      await expect(page.getByRole("region", { name: "Pengumuman" })).toHaveCount(0);
      expect(await top(page, "header")).toBe(0);

      await setStorefrontSettings({ announcementBarEnabled: true, announcementBarText: null });
      await page.goto("/shipping");
      await expect(page.getByRole("region", { name: "Pengumuman" })).toHaveCount(0);
      expect(await top(page, "header")).toBe(0);
    });
  }

  test("the longest text the admin allows (40 characters) still fits one line on a 360px phone", async ({ page }) => {
    // A realistic worst case: uppercase-wide letters, with spaces, at exactly the 40-char cap.
    const longest = "GRATIS ONGKIR MINIMUM BELANJA RP 500RIBU";
    expect(longest).toHaveLength(40);
    await setStorefrontSettings({ announcementBarText: longest });

    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      const text = page.getByRole("region", { name: "Pengumuman" }).locator("p");
      await expect(text).toHaveText(longest);
      const overflowing = await text.evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(overflowing, `40 characters overflow at ${width}px`).toBe(false);
    }
  });

  test("a new text from the admin is shown on the next request (no stale cache)", async ({ page }) => {
    await setStorefrontSettings({ announcementBarText: "Diskon Akhir Tahun E2E" });
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Pengumuman" })).toHaveText("Diskon Akhir Tahun E2E", { ignoreCase: true });
  });
});
