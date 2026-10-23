import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { storefrontRevalidateCalls } from "./helpers/storefront-stub";
import { E2E_FRESH_AFTER_SAVE_EMAIL } from "./global-setup";

// After a save, the page the form lands on must already show the change, with no reload: every
// mutating server action calls revalidateAdmin() (src/lib/admin-revalidate.ts), which drops the
// browser's cached route payloads before the form's router.push() runs. Each flow starts on the
// list and opens the form through its link (client-side), the way the owner works, so the list
// was already rendered once before the save. Nothing below calls page.reload() or page.goto()
// between a save and its assertions; that is the whole point of this spec.
//
// Covers each redirect pattern: create -> new detail page (fabrics, products), edit -> list
// (products, suppliers), create -> list (suppliers), delete from the record's own page -> list
// (fabrics). Accessories are left out on purpose: production-and-stock.spec.ts opens "the first
// accessory row" after creating its own, and a sorts-first name here would take that row. Runs at 390px and 1280px
// (CLAUDE.md): lists render a card layout on phones and a table on desktop, and only one of
// them is visible, so every list assertion targets the VISIBLE link for the row.

const UUID = "[0-9a-f-]{36}";
// `next dev` compiles a route on its first visit, which can take well past the 5s default on a
// loaded machine (same allowance helpers/open-created.ts gives its own redirect wait).
const NAV = { timeout: 15_000 };

/** Lists sort by name and paginate, so this run's records must sort onto page 1. Digits sort
 * before letters, and the key counts DOWN over time, so the newest run always sorts first even
 * after many earlier runs left their own rows behind in the shared `ammari_e2e` database. */
function sortsFirst(label: string): string {
  const descendingKey = String(9_999_999_999_999 - Date.now()).padStart(13, "0");
  return `0 ${descendingKey} ${label}`;
}

/** The row's link in whichever layout is showing. By contained text, not accessible name: a
 * phone card's link wraps the whole card (thumbnail, badges, fabric), while a table row's link is
 * just the name. Every name here carries its own unique key, so a substring can't hit another row. */
function visibleLink(page: Page, name: string) {
  return page.locator("main a").filter({ hasText: name }).filter({ visible: true });
}

async function runFlows(page: Page): Promise<void> {
  // ---- Fabric: create -> its new detail page ----
  const fabricName = sortsFirst("Bahan Segar");
  await page.goto("/fabrics");
  await page.getByRole("link", { name: "Tambah bahan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/new$/, NAV);
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/fabrics/${UUID}$`), NAV);
  await expect(page.getByRole("status")).toContainText("Bahan berhasil ditambahkan");
  await expect(page.getByRole("heading", { level: 1, name: fabricName })).toBeVisible();

  // ---- Product: create -> its new detail page ----
  const productName = sortsFirst("Gamis Segar");
  await page.goto("/products");
  await page.getByRole("link", { name: "Tambah produk" }).click();
  await expect(page).toHaveURL(/\/products\/new$/, NAV);
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  // Required since docs/plans/product-types.md; "Gamis" is the seeded DRESS type.
  await page.locator("#product-type").selectOption("DRESS");
  await page.getByLabel("Harga dasar").fill("269.000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${UUID}$`), NAV);
  await expect(page.getByRole("status")).toContainText("Produk berhasil ditambahkan");
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  // The detail page is the full editor for the new product, not a stale or empty shell.
  await expect(page.getByLabel("Nama produk")).toHaveValue(productName);

  // ---- Product: edit -> the list, showing the new name ----
  const slug = await page.getByLabel("Slug").inputValue();
  const renamedProduct = sortsFirst("Gamis Segar Diubah");
  const productForm = page.locator("form").filter({ has: page.locator("#product-name") });
  await page.getByLabel("Nama produk").fill(renamedProduct);
  await productForm.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/products$/, NAV);
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan");
  await expect(visibleLink(page, renamedProduct)).toBeVisible();
  await expect(visibleLink(page, productName)).toHaveCount(0);
  // The storefront revalidation (apps/web, stubbed here) still fires for the product's own page:
  // its PDP data tag, the related-products tag and the homepage tag (lib/revalidate.ts productTags).
  const calls = await storefrontRevalidateCalls(page.request);
  expect(calls).toContainEqual({
    paths: [`/products/${slug}`],
    tags: [`storefront:product:${slug}`, "storefront:products", "storefront:homepage"],
    secretMatched: true,
  });

  // ---- Supplier: create -> the list, showing the new supplier ----
  const supplierName = sortsFirst("Supplier Segar");
  await page.goto("/suppliers");
  await page.getByRole("link", { name: "Tambah supplier" }).click();
  await expect(page).toHaveURL(/\/suppliers\/new$/, NAV);
  await page.getByLabel("Nama supplier").fill(supplierName);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/suppliers$/, NAV);
  await expect(page.getByRole("status")).toContainText("Supplier berhasil ditambahkan");
  await expect(visibleLink(page, supplierName)).toBeVisible();

  // ---- Supplier: edit -> the list, showing the new name ----
  await visibleLink(page, supplierName).click();
  await expect(page).toHaveURL(new RegExp(`/suppliers/${UUID}$`), NAV);
  const renamedSupplier = sortsFirst("Supplier Segar Diubah");
  await page.getByLabel("Nama supplier").fill(renamedSupplier);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/suppliers$/, NAV);
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan");
  await expect(visibleLink(page, renamedSupplier)).toBeVisible();
  await expect(visibleLink(page, supplierName)).toHaveCount(0);

  // ---- Fabric: delete from its own detail page -> the list, with no 404 on the way ----
  // The delete revalidates, which re-renders the CURRENT (now deleted) page in the action
  // response; deleteFabricAction redirects server-side so that render is the list, never the
  // not-found page. A MutationObserver catches even a one-frame flash of it, which a plain
  // assertion after the fact would miss. It survives the client-side navigation (same document).
  const doomedFabric = sortsFirst("Bahan Dihapus");
  await page.goto("/fabrics");
  await page.getByRole("link", { name: "Tambah bahan" }).click();
  await page.getByLabel("Nama bahan").fill(doomedFabric);
  // No color: a fabric that still has a color can't be deleted (the empty starter row is skipped).
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: doomedFabric })).toBeVisible();
  await page.evaluate(() => {
    const flags = window as unknown as { __sawNotFound?: boolean };
    flags.__sawNotFound = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes("Halaman tidak ditemukan")) flags.__sawNotFound = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.locator("form").filter({ has: page.getByLabel("Nama bahan") }).getByRole("button", { name: "Hapus", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Hapus", exact: true }).click();
  await expect(page).toHaveURL(/\/fabrics$/, NAV);
  await expect(page.getByRole("heading", { level: 1, name: "Bahan" })).toBeVisible();
  await expect(visibleLink(page, doomedFabric)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sawNotFound?: boolean }).__sawNotFound)).toBe(false);
}

test.describe("saved data is visible right after the redirect, without a reload", () => {
  test.setTimeout(120_000);

  test("on mobile (390px)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, E2E_FRESH_AFTER_SAVE_EMAIL);
    await runFlows(page);
  });

  test("on desktop (1280px)", async ({ page }) => {
    await loginAs(page, E2E_FRESH_AFTER_SAVE_EMAIL);
    await runFlows(page);
  });
});
