import { test } from "@playwright/test";
import { E2E_PRODUCT_SLUG } from "./storefront-fixtures";

// Not a correctness check (no assertions) — captures the current render of `/` and the PDP at
// the two required viewports (docs/design/storefront.md's own "must work and be checked at 390px
// and 1280px" rule) for manual/visual comparison against docs/design/mockup-*.png.
//
// Default output is a GITIGNORED folder under this app's own `test-results/` (same directory
// Playwright already writes its own run artifacts to, and already covered by the root
// .gitignore's `test-results/` entry) — a normal `pnpm test:e2e` run must never touch tracked
// files. `docs/design/screens/` is reserved for INTENTIONALLY committed reference screenshots
// only, written by a separate, explicit opt-in command (`pnpm test:e2e:refresh-screens`, which
// sets REFRESH_VISUAL_SCREENS=true) — never the default. This fixes a real incident: the
// previous version of this spec always wrote straight into docs/design/screens/, so every normal
// e2e run silently overwrote whatever reference screenshots were last committed there.
const SCREENS_DIR = process.env.REFRESH_VISUAL_SCREENS === "true" ? "../../docs/design/screens" : "test-results/visual-screens";

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
