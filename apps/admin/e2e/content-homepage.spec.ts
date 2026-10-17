import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { createAndPublishProduct } from "./helpers/publishable-product";
import { E2E_PRODUCTS_NO_FINANCE_EMAIL, E2E_STOREFRONT_EMAIL } from "./global-setup";

/** Hero draft -> "Ada perubahan belum diterbitkan" -> Terbitkan -> banner clears; a further
 * unsaved edit -> banner reappears -> "Batalkan perubahan" reverts the draft back to what's
 * actually published (docs/plans/storefront-cms.md's draft/publish contract) — the whole loop
 * is driven through the admin UI only (no apps/web yet, session 7), so "published content
 * matches" is verified by discard round-tripping back to it, not by visiting a live page. */
async function runPublishAndDiscardFlow(page: Page, label: string): Promise<void> {
  await page.goto("/content/hero");
  await page.getByLabel("Headline").fill(`Headline Terbit ${label}`);
  await page.getByLabel("Label tombol").fill("Belanja Sekarang");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await page.waitForLoadState("networkidle");

  await page.goto("/content");
  await expect(page.getByTestId("unpublished-changes-banner")).toBeVisible();
  await page.getByRole("button", { name: "Terbitkan" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("unpublished-changes-banner")).toHaveCount(0);

  await page.goto("/content/hero");
  await page.getByLabel("Headline").fill(`Headline Belum Terbit ${label}`);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await page.waitForLoadState("networkidle");

  await page.goto("/content");
  await expect(page.getByTestId("unpublished-changes-banner")).toBeVisible();
  await page.getByRole("button", { name: "Batalkan perubahan" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("unpublished-changes-banner")).toHaveCount(0);

  await page.goto("/content/hero");
  await expect(page.getByLabel("Headline")).toHaveValue(`Headline Terbit ${label}`);
}

async function tileNames(page: Page): Promise<string[]> {
  return page.locator("li").filter({ has: page.getByRole("button", { name: /Naikkan urutan/ }) }).allTextContents();
}

function indexOfTile(names: string[], productName: string): number {
  const index = names.findIndex((text) => text.includes(productName));
  if (index === -1) throw new Error(`tile for "${productName}" not found among: ${names.join(", ")}`);
  return index;
}

/** Two published products added to the Product Grid tile list, reordered with the up/down
 * buttons, saved, and confirmed to persist in the new order after a reload — checked by RELATIVE
 * position of these two tiles (never an absolute count/index), since this flow runs twice in the
 * same test (390px then 1280px) against the same shared draft, so earlier tiles from the first
 * pass are still present during the second. */
async function runProductGridReorderFlow(page: Page, label: string): Promise<void> {
  const first = await createAndPublishProduct(page, `${label}-a`);
  const second = await createAndPublishProduct(page, `${label}-b`, first.sizeChartName);

  await page.goto("/content/product-grid");
  await page.getByLabel("Judul").fill(`Grid ${label}`);
  await page.locator("#product-grid-add-product").selectOption({ label: first.productName });
  await page.getByRole("button", { name: "Tambah ke grid" }).click();
  await page.locator("#product-grid-add-product").selectOption({ label: second.productName });
  await page.getByRole("button", { name: "Tambah ke grid" }).click();

  // Newly added tiles are appended, so `first` (added first) starts before `second`.
  let names = await tileNames(page);
  expect(indexOfTile(names, first.productName)).toBeLessThan(indexOfTile(names, second.productName));

  await page.getByRole("button", { name: `Naikkan urutan ${second.productName}` }).click();
  names = await tileNames(page);
  expect(indexOfTile(names, second.productName)).toBeLessThan(indexOfTile(names, first.productName));

  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(page.url());

  names = await tileNames(page);
  expect(indexOfTile(names, second.productName)).toBeLessThan(indexOfTile(names, first.productName));
}

/** The /content overview's per-row visibility switch flips ONE section's draft visibility
 * without a full editor round trip, and the new value persists after a reload — flips to
 * whichever state it ISN'T currently in (never assumes a starting value), since this flow also
 * runs twice in the same test against the same shared row. */
async function runHideSectionFlow(page: Page): Promise<void> {
  await page.goto("/content");
  const whyAmmariRow = page.getByTestId("homepage-section-row-why_ammari");
  const before = await whyAmmariRow.getByRole("switch").getAttribute("aria-checked");
  const nextChecked = before === "true" ? "false" : "true";

  await whyAmmariRow.getByRole("switch").click();
  await expect(whyAmmariRow.getByRole("switch")).toHaveAttribute("aria-checked", nextChecked);

  await page.goto(page.url());
  await expect(page.getByTestId("homepage-section-row-why_ammari").getByRole("switch")).toHaveAttribute("aria-checked", nextChecked);
}

test.describe("Konten: Beranda (homepage sections)", () => {
  test("publish/discard a draft, reorder product grid tiles, and hide a section — at both 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runPublishAndDiscardFlow(page, "mobile");
    await runProductGridReorderFlow(page, "mobile");
    await runHideSectionFlow(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await runPublishAndDiscardFlow(page, "desktop");
    await runProductGridReorderFlow(page, "desktop");
    await runHideSectionFlow(page);
  });

  test("the section's own editor shows an unpublished-changes banner naming the section, with Terbitkan right there — not just the /content overview", async ({
    page,
  }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.goto("/content/hero");
    await page.getByLabel("Headline").fill(`Headline Section Banner ${Date.now()}`);
    await page.getByLabel("Label tombol").fill("Belanja Sekarang");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await page.waitForLoadState("networkidle");

    // Reload the SAME section page (not /content) — the banner names Hero and appears right
    // here, without needing a trip to the overview.
    await page.goto(page.url());
    const banner = page.getByTestId("hero-unpublished-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Hero");
    await expect(banner).toContainText("semua bagian beranda sekaligus");

    await banner.getByRole("button", { name: "Terbitkan" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("hero-unpublished-banner")).toHaveCount(0);
  });

  test("warns before leaving the hero editor with unsaved edits", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);
    await page.goto("/content/hero");
    await page.getByLabel("Headline").fill(`Headline Unsaved ${Date.now()}`);

    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("navigation", { name: "Navigasi breadcrumb" }).getByRole("link", { name: "Beranda" }).click();
    // Dismissing the confirm cancels the navigation — still on the hero editor, edit intact.
    await expect(page).toHaveURL(/\/content\/hero$/);
    await expect(page.getByLabel("Headline")).toHaveValue(/Headline Unsaved/);
  });

  test("a staff user without content.manage is denied /content and its section editors, and never sees the Beranda nav item", async ({ page }) => {
    await loginAs(page, E2E_PRODUCTS_NO_FINANCE_EMAIL); // products.manage only, no content.manage

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Beranda" })).toHaveCount(0);

    await page.goto("/content");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();

    await page.goto("/content/hero");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  });
});
