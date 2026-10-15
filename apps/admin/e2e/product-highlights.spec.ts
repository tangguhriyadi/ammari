import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PRODUCT_HIGHLIGHTS_EMAIL } from "./global-setup";

// A fixed set, not free text (owner requirement — the storefront maps each key to its own
// icon) — the admin form is 5 checkboxes for these exact Indonesian labels, no add/remove/
// reorder UI at all. Display order (here and on /products) is always this canonical order,
// never whatever order the checkboxes happened to be clicked in.
const BREATHABLE = "Breathable";
const FLOWY = "Flowy";
const FALLS_PERFECTLY = "Jatuh sempurna";

async function createProduct(page: Page, label: string): Promise<{ productName: string }> {
  const unique = `${label}-${Date.now()}`;

  const fabricName = `E2E Bahan Keunggulan ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Keunggulan E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  return { productName };
}

async function checkedHighlightLabels(page: Page): Promise<string[]> {
  const checked: string[] = [];
  for (const label of [BREATHABLE, FLOWY, FALLS_PERFECTLY, "Bahan sejuk", "Tidak menerawang"]) {
    if (await page.getByRole("checkbox", { name: label, exact: true }).isChecked()) checked.push(label);
  }
  return checked;
}

test.describe("product highlights (Keunggulan)", () => {
  test("check/uncheck on create and edit; canonical order persists after reload; read-only on /products", async ({ page }) => {
    await loginAs(page, E2E_PRODUCT_HIGHLIGHTS_EMAIL);

    // --- Mobile (390px) ---
    await page.setViewportSize({ width: 390, height: 844 });
    const { productName: mobileProductName } = await createProduct(page, "mobile");

    // Check them OUT of canonical order (Jatuh sempurna is #3, Breathable is #1) — the STORED
    // order must still come out canonical, never click order.
    await page.getByRole("checkbox", { name: FALLS_PERFECTLY, exact: true }).check();
    await page.getByRole("checkbox", { name: BREATHABLE, exact: true }).check();
    await expect(page.getByTestId("highlights-counter")).toHaveText("2/5");

    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    // Lets the click's OWN client-side router.push/refresh fully settle before the next line's
    // hard navigation — firing `page.goto` immediately after races that in-flight navigation
    // and can intermittently land on a stale pre-save snapshot (docs/plans/product-highlights.md
    // records the earlier debugging session that tracked this down to a test-timing issue, not
    // an actual persistence bug — confirmed by querying the database directly at the time).
    await page.waitForLoadState("networkidle");
    await page.goto(page.url());

    expect(await checkedHighlightLabels(page)).toEqual([BREATHABLE, FALLS_PERFECTLY]);
    await expect(page.getByTestId("highlights-counter")).toHaveText("2/5");

    // Uncheck one, check a third.
    await page.getByRole("checkbox", { name: BREATHABLE, exact: true }).uncheck();
    await page.getByRole("checkbox", { name: FLOWY, exact: true }).check();
    await expect(page.getByTestId("highlights-counter")).toHaveText("2/5");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await page.waitForLoadState("networkidle");
    await page.goto(page.url());
    expect(await checkedHighlightLabels(page)).toEqual([FLOWY, FALLS_PERFECTLY]);

    // Read-only on the list page too (mobile CardList), in canonical order ("Flowy" before
    // "Jatuh sempurna" — PRODUCT_HIGHLIGHT_KEYS' own order, not insertion order).
    await page.goto("/products");
    const mobileCard = page.locator("li").filter({ hasText: mobileProductName });
    await expect(mobileCard.getByText(FLOWY, { exact: true })).toBeVisible();
    await expect(mobileCard.getByText(FALLS_PERFECTLY, { exact: true })).toBeVisible();
    await expect(mobileCard.getByText(BREATHABLE, { exact: true })).toHaveCount(0);

    // --- Desktop (project default, 1280px) ---
    await page.setViewportSize({ width: 1280, height: 800 });
    const { productName: desktopProductName } = await createProduct(page, "desktop");

    // All 5 — the max is exactly the number of checkboxes, so there's nothing to "disable at
    // the limit"; checking every box IS the max, structurally.
    for (const label of [FALLS_PERFECTLY, "Tidak menerawang", BREATHABLE, "Bahan sejuk", FLOWY]) {
      await page.getByRole("checkbox", { name: label, exact: true }).check();
    }
    await expect(page.getByTestId("highlights-counter")).toHaveText("5/5");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await page.waitForLoadState("networkidle");
    await page.goto(page.url());
    expect(await checkedHighlightLabels(page)).toEqual([BREATHABLE, FLOWY, FALLS_PERFECTLY, "Bahan sejuk", "Tidak menerawang"]);

    // Uncheck down to 2.
    await page.getByRole("checkbox", { name: "Bahan sejuk", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "Tidak menerawang", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: FALLS_PERFECTLY, exact: true }).uncheck();
    await expect(page.getByTestId("highlights-counter")).toHaveText("2/5");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await page.waitForLoadState("networkidle");
    await page.goto(page.url());
    expect(await checkedHighlightLabels(page)).toEqual([BREATHABLE, FLOWY]);

    // Read-only on the list page too (desktop TableContainer).
    await page.goto("/products");
    const desktopRow = page.locator("tr").filter({ hasText: desktopProductName });
    await expect(desktopRow.getByText(BREATHABLE, { exact: true })).toBeVisible();
    await expect(desktopRow.getByText(FLOWY, { exact: true })).toBeVisible();
    await expect(desktopRow.getByText(FALLS_PERFECTLY, { exact: true })).toHaveCount(0);
  });
});
