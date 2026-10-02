import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_OWNER_EMAIL, E2E_PAGINATION_PRODUCT_PREFIX, E2E_PRODUCTS_NO_FINANCE_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

// Mobile-first per the product spec — the whole flow below (forms, variant builder, SKU
// display) runs at 390x844 rather than only checking SKUs at the end.
test.use({ viewport: { width: 390, height: 844 } });

test("owner creates a fabric, adds colors, creates a product with variants, and sees the generated SKUs on mobile; Batas HPP is visible", async ({
  page,
}) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  const unique = Date.now();

  // 1. Create a fabric with a color added inline, in the same submit (no save-then-add-color
  // round trip). The form always starts with one empty color row.
  const fabricName = `E2E Bahan ${unique}`;
  await page.goto("/bahan/baru");
  await page.getByLabel("Nama bahan").fill(fabricName);
  // exact: true — the new color row's "Kode pemasok (opsional)" label otherwise substring-matches
  // "Pemasok" too (same class of bug as "Produk" vs "Produksi" elsewhere in this app's e2e).
  await page.getByLabel("Pemasok", { exact: true }).fill("E2E Supplier");
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  // Creating a fabric redirects straight to its detail page now, not the list.
  await expect(page).toHaveURL(/\/bahan\/[0-9a-f-]+$/);
  // The color's name shows up as an editable input's value, not text content — after the
  // navigation's server round-trip, the SSR'd HTML has a literal value="Sage" attribute on that
  // row's input, so a CSS attribute selector finds it.
  await expect(page.locator('input[value="Sage"]')).toBeVisible();

  // 3. Create a product using that fabric.
  const productName = `Contoh Gamis E2E ${unique}`; // never a fabric name, per docs/SPEC.md
  await page.goto("/produk/baru");
  await page.getByLabel("Nama produk").fill(productName);
  // By id, not getByLabel("Bahan") — the required-field asterisk is appended inside the same
  // <label>, which also computes an accessible name substring collision risk elsewhere.
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/produk\/[0-9a-f-]+$/);

  // 4. Pick the fabric's color and two sizes.
  await page.getByRole("checkbox", { name: /Sage/ }).check();
  // exact: true — "S" and "L" are substrings of "XS" and "XL", so a non-exact match would hit
  // both checkboxes (same class of bug as "Produk" vs "Produksi" elsewhere in this app's e2e).
  await page.getByRole("checkbox", { name: "S", exact: true }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();

  const expectedSkuS = generateSku({ code, closure: "front_zip", color: "Sage", size: "S" });
  const expectedSkuM = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
  await expect(page.getByText(expectedSkuS, { exact: true })).toBeVisible();
  await expect(page.getByText(expectedSkuM, { exact: true })).toBeVisible();

  // 5. Batas HPP is visible for owner (holds finance.view_profit).
  await expect(page.getByText("Batas HPP")).toBeVisible();
});

test("owner creates a fabric with 2 colors in one submit, on mobile; both appear on the detail page", async ({ page }) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  const fabricName = `E2E Bahan Multi ${Date.now()}`;

  await page.goto("/bahan/baru");
  await page.getByLabel("Nama bahan").fill(fabricName);

  // Row 1 is already on the page; fill it, then add and fill a second row.
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "+ Tambah warna" }).click();
  await page.getByLabel("Nama warna").nth(1).fill("Mocca");

  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/bahan\/[0-9a-f-]+$/);

  await expect(page.locator('input[value="Sage"]')).toBeVisible();
  await expect(page.locator('input[value="Mocca"]')).toBeVisible();
});

test("a duplicate color name in the same fabric-creation submit is rejected, with the error next to the offending row", async ({
  page,
}) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  const fabricName = `E2E Bahan Dup ${Date.now()}`;

  await page.goto("/bahan/baru");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "+ Tambah warna" }).click();
  // Case-insensitive duplicate of row 1's "Sage".
  await page.getByLabel("Nama warna").nth(1).fill("sage");

  await page.getByRole("button", { name: "Simpan" }).click();

  // Stays on the create form — nothing was saved.
  await expect(page).toHaveURL(/\/bahan\/baru$/);
  // The error is shown both generically (a form-level alert) and next to the offending row (its
  // input gets aria-invalid + its own alert) — .first() because both render the same message, and
  // the aria-invalid check is what actually proves it landed on row 2 specifically.
  await expect(page.getByText(/sudah dipakai di baris 1/).first()).toBeVisible();
  await expect(page.getByLabel("Nama warna").nth(1)).toHaveAttribute("aria-invalid", "true");
});

test("a role without finance.view_profit does not receive Batas HPP in the HTML at all", async ({ page }) => {
  await loginAs(page, E2E_PRODUCTS_NO_FINANCE_EMAIL);
  await page.goto("/produk");
  // Excludes "/produk/baru" (the create-product link) — also matches a bare href^="/produk/"
  // prefix selector.
  const firstProductLink = page.locator('a[href^="/produk/"]:not([href="/produk/baru"])').first();
  await firstProductLink.click();
  await expect(page).toHaveURL(/\/produk\/[0-9a-f-]+$/);

  // Not just "not visible" (which a CSS-hidden element would also satisfy) — the string itself
  // must not be present anywhere in the rendered HTML, proving the server never sent it.
  const html = await page.content();
  expect(html).not.toContain("Batas HPP");
});

test("product list pagination: page 2 shows different products than page 1", async ({ page }) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  await page.goto(`/produk?q=${encodeURIComponent(E2E_PAGINATION_PRODUCT_PREFIX)}`);

  await expect(page.getByText("21 produk", { exact: false })).toBeVisible();
  await expect(page.getByText(`${E2E_PAGINATION_PRODUCT_PREFIX} 00`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`${E2E_PAGINATION_PRODUCT_PREFIX} 20`, { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Berikutnya" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText(`${E2E_PAGINATION_PRODUCT_PREFIX} 20`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`${E2E_PAGINATION_PRODUCT_PREFIX} 00`, { exact: true })).toHaveCount(0);
});
