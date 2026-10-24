import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PRODUCT_TYPES_EMAIL } from "./global-setup";

// docs/plans/product-types.md: the "Jenis Produk" master and its use on products. Runs the whole
// flow at 390px AND at the project's default 1280px (CLAUDE.md's rule) — /product-types and
// /products each render two independent layouts (CardList for phones, TableContainer for
// tablet/desktop), so every list assertion goes through the row of THIS viewport's layout and
// also checks the other layout's row is hidden, not missing.
interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile" };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop" };

function rowFor(page: Page, layout: Layout, text: string) {
  return page.locator(layout.rowTag).filter({ hasText: text });
}

function hiddenRowFor(page: Page, layout: Layout, text: string) {
  return page.locator(layout.hiddenRowTag).filter({ hasText: text });
}

/** Scopes the product list to this run's product (the e2e database holds other specs' products)
 * and applies the type filter through the real GET form. */
async function filterProducts(page: Page, marker: string, typeLabel: string): Promise<void> {
  await page.goto("/products");
  await page.getByLabel("Cari produk").fill(marker);
  await page.getByLabel("Jenis produk").selectOption({ label: typeLabel });
  await page.getByRole("button", { name: "Terapkan" }).click();
  await page.waitForURL(/\/products\?.*type=/);
}

async function runProductTypeFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const code = `E2E_${layout.label.toUpperCase()}_${String(Date.now()).slice(-6)}`;
  const typeName = `E2E Jenis ${marker}`;
  const renamedType = `E2E Khimar ${marker}`;

  // 1. Add a type. The code is typed in lowercase on purpose: the form uppercases it.
  await page.goto("/product-types/new");
  await page.getByLabel("Kode").fill(code.toLowerCase());
  await expect(page.getByLabel("Kode")).toHaveValue(code);
  await page.getByLabel("Nama tampilan").fill(typeName);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/product-types$/);
  await expect(page.getByRole("status")).toContainText("Jenis produk berhasil ditambahkan");
  await expect(rowFor(page, layout, typeName)).toBeVisible();
  await expect(rowFor(page, layout, typeName)).toContainText("Belum dipakai");
  await expect(hiddenRowFor(page, layout, typeName).first()).toBeHidden();
  // The seeded default is on the list too.
  await expect(rowFor(page, layout, "Gamis").filter({ hasText: "DRESS" }).first()).toBeVisible();

  // 2. Rename it. The code is shown but can't be edited.
  await rowFor(page, layout, typeName).getByRole("link", { name: typeName }).click();
  await expect(page).toHaveURL(new RegExp(`/product-types/${code}$`));
  await expect(page.getByLabel("Kode")).toHaveValue(code);
  await expect(page.getByLabel("Kode")).toBeDisabled();
  await page.getByLabel("Nama tampilan").fill(renamedType);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/product-types$/);
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan");
  await expect(rowFor(page, layout, renamedType)).toBeVisible();
  await expect(rowFor(page, layout, typeName)).toHaveCount(0);

  // 3. A product picks the type in the product form ("Jenis produk" is required: saving without
  // one is refused by the browser's required check before anything is sent).
  const fabricName = `E2E Bahan Jenis ${marker}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Jenis ${marker}`;
  await page.goto("/products/new");
  await expect(page.locator("#product-type")).toHaveValue("");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  await page.getByRole("button", { name: "Lanjut", exact: true }).click();
  await expect(page).toHaveURL(/\/products\/new$/);
  await page.locator("#product-type").selectOption({ label: renamedType });
  await page.getByRole("button", { name: "Lanjut", exact: true }).click();
  // Saved as a draft; the stepper moves on to step 2. The type is on step 1 of the edit page.
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+\/setup\?step=varian/);
  const productUrl = `/products/${new URL(page.url()).pathname.split("/")[2]}`;
  await page.goto(productUrl);
  await expect(page.locator("#product-type")).toHaveValue(code);

  // 4. The product list shows the type, and the type filter finds it (and the Gamis filter doesn't).
  await filterProducts(page, marker, renamedType);
  await expect(rowFor(page, layout, productName)).toBeVisible();
  await expect(rowFor(page, layout, productName).getByTestId("product-type")).toHaveText(renamedType);
  await expect(hiddenRowFor(page, layout, productName).first()).toBeHidden();
  await filterProducts(page, marker, "Gamis");
  await expect(rowFor(page, layout, productName)).toHaveCount(0);
  await expect(page.getByText("Tidak ada produk yang cocok")).toBeVisible();

  // The type list counts the product now.
  await page.goto("/product-types");
  await expect(rowFor(page, layout, renamedType)).toContainText("Dipakai 1 produk");

  // 5. Deactivate the type from the list (no delete exists).
  await rowFor(page, layout, renamedType).getByRole("switch").click();
  await expect(rowFor(page, layout, renamedType).getByText("Nonaktif")).toBeVisible({ timeout: 15_000 });

  // 6. An inactive type can't be picked for a new product...
  await page.goto("/products/new");
  await expect(page.locator("#product-type option", { hasText: "Gamis" }).first()).toBeAttached();
  await expect(page.locator("#product-type option", { hasText: renamedType })).toHaveCount(0);

  // ...but stays on the product that uses it, marked, and that product still saves unchanged.
  await page.goto(productUrl);
  await expect(page.locator("#product-type")).toHaveValue(code);
  await expect(page.locator("#product-type option:checked")).toHaveText(`${renamedType} (nonaktif)`);
  // Scoped to the product form: the detail page has other sections with their own "Simpan".
  await page.locator("form").filter({ has: page.locator("#product-type") }).getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan");

  // The list filter still offers it (marked), and the row shows it marked.
  await filterProducts(page, marker, `${renamedType} (nonaktif)`);
  await expect(rowFor(page, layout, productName).getByTestId("product-type")).toHaveText(`${renamedType} (nonaktif)`);

  // 7. Reactivating makes it selectable again.
  await page.goto("/product-types");
  await rowFor(page, layout, renamedType).getByRole("switch").click();
  await expect(rowFor(page, layout, renamedType).getByText("Nonaktif")).toHaveCount(0, { timeout: 15_000 });
  await page.goto("/products/new");
  await expect(page.locator("#product-type option", { hasText: renamedType })).toHaveCount(1);
}

test.describe("product types (Jenis Produk)", () => {
  test("add, rename, pick on a product, filter the list, deactivate and reactivate — mobile 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, E2E_PRODUCT_TYPES_EMAIL);
    await runProductTypeFlow(page, MOBILE);
  });

  test("add, rename, pick on a product, filter the list, deactivate and reactivate — desktop 1280px", async ({ page }) => {
    await loginAs(page, E2E_PRODUCT_TYPES_EMAIL);
    await runProductTypeFlow(page, DESKTOP);
  });
});
