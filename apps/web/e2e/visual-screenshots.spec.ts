import { test } from "@playwright/test";
import { E2E_PRODUCT_SLUG } from "./storefront-fixtures";

// Not a correctness check (no assertions) — captures the current render of `/` and the PDP at
// the two required viewports (docs/design/storefront.md's own "must work and be checked at 390px
// and 1280px" rule) for manual/visual comparison against docs/design/mockup-*.png. Saved under
// docs/design/screens/, outside Playwright's own test-results/ output, so they survive a
// `playwright show-report` cleanup and are easy for the owner to find.
const SCREENS_DIR = "../../docs/design/screens";

test.describe("visual QA screenshots", () => {
  test("home — 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SCREENS_DIR}/home-390.png`, fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SCREENS_DIR}/home-1280.png`, fullPage: true });
  });

  test("product page — 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SCREENS_DIR}/product-390.png`, fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${SCREENS_DIR}/product-1280.png`, fullPage: true });
  });
});
