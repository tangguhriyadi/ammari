import { expect, type Page } from "@playwright/test";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type ProductStep = "info" | "varian" | "foto" | "toko" | "aksesoris";

export interface ProductDraftInput {
  name: string;
  /** The fabric's exact name, as shown in the "Bahan" select. */
  fabricName: string;
  basePrice?: string;
  /** Leave the "Aktif" switch on (the form's default) or switch it off. */
  active?: boolean;
  shippingWeightGrams?: string;
  /** Defaults to the seeded "Gamis" type, required since docs/plans/product-types.md. */
  productTypeCode?: string;
}

/** Step 1 of the product stepper (docs/plans/product-stepper.md): fills the form on
 * /products/new, presses "Lanjut" and waits for step 2 (Varian) of the saved draft. Every spec
 * that needs a product goes through here, so a change to step 1 is fixed in one place. */
export async function createProductDraft(page: Page, input: ProductDraftInput): Promise<{ productId: string; code: string }> {
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(input.name);
  // By id, not getByLabel("Bahan"): the required-field asterisk sits inside the same <label>.
  await page.locator("#product-fabric").selectOption({ label: input.fabricName });
  await page.locator("#product-type").selectOption(input.productTypeCode ?? "DRESS");
  await page.getByLabel("Harga dasar").fill(input.basePrice ?? "269.000");
  if (input.shippingWeightGrams) await page.getByLabel("Berat kirim (gram)").fill(input.shippingWeightGrams);
  const code = await page.getByLabel("Kode produk").inputValue();
  // Switch, not a checkbox: role="switch" has no check()/uncheck(), click to toggle it off.
  if (input.active === false) await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Lanjut", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${UUID}/setup\\?step=varian&reached=varian$`), { timeout: 15_000 });
  const productId = new URL(page.url()).pathname.split("/")[2]!;
  return { productId, code };
}

/** Ticks one colour and some sizes in the Varian step's "Tambah varian" form and adds them.
 * `exact: true` on sizes: "S" and "L" are substrings of "XS" and "XL". */
export async function addVariants(page: Page, color: string | RegExp, sizes: readonly string[]): Promise<void> {
  const colorCheckbox = page.getByRole("checkbox", { name: typeof color === "string" ? new RegExp(color) : color });
  await colorCheckbox.check();
  for (const size of sizes) await page.getByRole("checkbox", { name: size, exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  // AddVariantForm clears its selection only once the variants exist (the button is also
  // disabled while the request is in flight, so that alone proves nothing).
  await expect(colorCheckbox).not.toBeChecked({ timeout: 15_000 });
}

/** Opens one step of an existing product in edit mode (`/products/[id]?step=`). */
export async function openProductStep(page: Page, productId: string, step: ProductStep): Promise<void> {
  await page.goto(`/products/${productId}?step=${step}`);
  await expect(page.getByTestId("product-step-content")).toHaveAttribute("data-step", step);
}

/** The step bar's item for `step` (a link, or a plain item when it is current or locked). */
export function stepItem(page: Page, step: ProductStep) {
  return page.getByRole("navigation", { name: "Langkah produk" }).getByTestId(`step-${step}`);
}
