import { expect, test } from "@playwright/test";
import { E2E_FEATURE_BLOCK_TITLE, E2E_HOMEPAGE_TITLE, E2E_WHY_AMMARI_HEADING } from "./storefront-fixtures";

// docs/plans/storefront-cms.md session 7's own testing plan: "homepage renders the published
// sections in order ... hidden sections don't render" — at both 390px (CLAUDE.md's mobile list-
// page rule) and the Playwright project default desktop viewport.
test.describe("/ renders the published homepage", () => {
  test("renders every published section, in order, at 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // Hero
    await expect(page.getByRole("heading", { level: 1, name: /Graceful in every/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "LIHAT KOLEKSI" })).toBeVisible();

    // Product grid
    await expect(page.getByRole("heading", { level: 2, name: E2E_HOMEPAGE_TITLE })).toBeVisible();
    await expect(page.getByText("3 produk")).toBeVisible();

    // Kenapa Ammari
    await expect(page.getByRole("heading", { level: 2, name: E2E_WHY_AMMARI_HEADING })).toBeVisible();
    await expect(page.getByText("Tidak menerawang")).toBeVisible();

    // Feature block
    await expect(page.getByRole("heading", { level: 3, name: E2E_FEATURE_BLOCK_TITLE })).toBeVisible();
    await expect(page.getByRole("link", { name: "LIHAT" }).last()).toBeVisible();

    // Section order: hero, then grid, then "kenapa ammari", then feature block.
    const headingOrder = await page.locator("h1, h2, h3").allTextContents();
    const heroIndex = headingOrder.findIndex((t) => t.includes("Graceful in every"));
    const gridIndex = headingOrder.findIndex((t) => t === E2E_HOMEPAGE_TITLE);
    const whyIndex = headingOrder.findIndex((t) => t === E2E_WHY_AMMARI_HEADING);
    const featureIndex = headingOrder.findIndex((t) => t === E2E_FEATURE_BLOCK_TITLE);
    expect(heroIndex).toBeLessThan(gridIndex);
    expect(gridIndex).toBeLessThan(whyIndex);
    expect(whyIndex).toBeLessThan(featureIndex);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /Graceful in every/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: E2E_HOMEPAGE_TITLE })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: E2E_WHY_AMMARI_HEADING })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: E2E_FEATURE_BLOCK_TITLE })).toBeVisible();
  });

  test("Hero CTA is outlined by default and fills to the solid brand colour on hover, at 390px and 1280px", async ({ page }) => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const cta = page.getByRole("link", { name: "LIHAT KOLEKSI" });

      await expect(cta).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(cta).toHaveCSS("border-color", "rgb(105, 90, 90)");
      await expect(cta).toHaveCSS("color", "rgb(105, 90, 90)");

      await cta.hover();
      await expect(cta).toHaveCSS("background-color", "rgb(105, 90, 90)");
      await expect(cta).toHaveCSS("color", "rgb(255, 255, 255)");
    }
  });

  test("a product grid tile links to its product, with ?color= only when the tile pins a colour", async ({ page }) => {
    await page.goto("/");
    const unpinnedTile = page.getByRole("link", { name: /Gamis Flowy Straight E2E/ }).first();
    await expect(unpinnedTile).toHaveAttribute("href", /\/products\/gamis-flowy-straight-e2e$/);

    const pinnedTile = page.getByRole("link", { name: /Navy E2E/ });
    await expect(pinnedTile).toHaveAttribute("href", /\/products\/gamis-flowy-straight-e2e\?color=/);
  });
});
