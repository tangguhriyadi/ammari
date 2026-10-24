import { expect, test } from "@playwright/test";
import { generateSku } from "@ammari/db/catalog";
import type { Size } from "@ammari/db/schema";
import { loginAs } from "./helpers/login";
import { jpegFixture } from "./helpers/publishable-product";
import { createProductDraft, openProductStep, stepItem } from "./helpers/product";
import { E2E_VARIANT_PHOTOS_EMAIL } from "./global-setup";

// Variants are active the moment they're created, photo or not: production, stock and orders
// need them before any photo exists. A photo-less color only gets a non-blocking "Belum ada foto"
// reminder; adding a photo clears it without a reload; photos get a default alt text.
test("new variants are active without a photo, show up in a production batch, and the product page stays in sync after a photo upload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_VARIANT_PHOTOS_EMAIL);
  const unique = Date.now();

  // 1. Fixtures: a fabric with one color, and a product left ACTIVE (the form's default).
  const fabricName = `E2E Bahan Varian Foto ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Taupe");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Varian Foto E2E ${unique}`;
  const { productId, code } = await createProductDraft(page, { name: productName, fabricName });
  const skuOf = (size: Size) => generateSku({ code, closure: "front_zip", color: "Taupe", size });

  // 2. Add S, M, L on Taupe: all three come in ACTIVE immediately, with no photo anywhere.
  const addButton = page.getByRole("button", { name: "Tambah varian" });
  await expect(addButton).toBeDisabled(); // nothing selected yet
  await page.getByRole("checkbox", { name: /Taupe/ }).check();
  for (const size of ["S", "M", "L"]) await page.getByRole("checkbox", { name: size, exact: true }).check();
  await expect(addButton).toBeEnabled();
  await addButton.click();
  for (const size of ["S", "M", "L"] as const) {
    await expect(page.locator(`:text-is("${skuOf(size)}"):visible`)).toBeVisible();
    await expect(page.locator(`[aria-label="Aktif untuk ukuran ${size}"]:visible`)).toHaveAttribute("aria-checked", "true");
  }
  await expect(page.getByText(/Nonaktif \(/)).toHaveCount(0);
  await expect(page.getByText(/belum aktif/)).toHaveCount(0);
  // The reminder badge shows on the variant color group (this step) AND the Foto step's Taupe group.
  await expect(page.getByText("Belum ada foto")).toHaveCount(1);
  await openProductStep(page, productId, "foto");
  await expect(page.getByText("Belum ada foto")).toHaveCount(1);

  // 3. The "Toko online" card says a photo is needed, with a jump to the Foto step (no
  // "di bawah"/"di atas" copy); the jump opens it and focuses the Foto heading.
  await openProductStep(page, productId, "toko");
  const storefront = page.getByTestId("storefront-section");
  await expect(storefront.getByTestId("storefront-needs-photo")).toBeVisible();
  await expect(storefront).not.toContainText(/di (bawah|atas)/);
  await storefront.getByRole("link", { name: "Buka bagian Foto" }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${productId}\\?step=foto#product-photos$`));
  await expect(page.getByRole("heading", { name: "Foto", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Foto", exact: true })).toBeInViewport();

  // 4. The product list flags the missing photo, in BOTH list layouts (CLAUDE.md: 390px + 1280px).
  await page.goto(`/products?q=${encodeURIComponent(productName)}`);
  await expect(page.locator("li").filter({ hasText: productName }).getByText("Belum ada foto")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("tr").filter({ hasText: productName }).getByText("Belum ada foto")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  // 5. A new production batch on this fabric offers all three SKU rows right away.
  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
  for (const size of ["S", "M", "L"] as const) await expect(page.locator(`#qty-${skuOf(size)}`)).toBeVisible();

  // 6. Upload a Taupe photo: the badges clear WITHOUT a manual reload, and the photo got the
  // default alt text "<product> warna Taupe".
  await openProductStep(page, productId, "foto");
  const taupeGroup = page
    .locator('[data-testid^="photo-group-"]')
    .filter({ has: page.getByRole("heading", { name: "Taupe", exact: true }) });
  await taupeGroup.locator('input[type="file"]').setInputFiles({ name: "taupe.jpg", mimeType: "image/jpeg", buffer: await jpegFixture() });
  await page.getByTestId("save-photos-button").click();
  const taupeTile = taupeGroup.getByTestId("photo-tile");
  await expect(taupeTile).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText("Belum ada foto")).toHaveCount(0);
  await taupeTile.getByRole("button", { name: "Opsi foto" }).click();
  await page.getByRole("menuitem", { name: "Ubah teks alternatif" }).click();
  await expect(page.getByRole("dialog").getByLabel("Teks alternatif")).toHaveValue(`${productName} warna Taupe`);
  await page.keyboard.press("Escape");
  // Through the step bar (a client-side navigation): the other steps are in sync too.
  await stepItem(page, "toko").click();
  await expect(storefront.getByTestId("storefront-needs-photo")).toHaveCount(0);
  await stepItem(page, "varian").click();
  await expect(page.getByText("Belum ada foto")).toHaveCount(0);

  // 7. Add another size to the same color, still without reloading. Re-ticking only existing
  // sizes keeps the button disabled (nothing new); adding XL enables it and adds just XL.
  await page.getByRole("checkbox", { name: /Taupe/ }).check();
  await page.getByRole("checkbox", { name: "S", exact: true }).check();
  await expect(addButton).toBeDisabled();
  await expect(page.getByText("Ukuran yang dipilih sudah ada untuk warna ini. Pilih ukuran lain.")).toBeVisible();
  await page.getByRole("checkbox", { name: "XL", exact: true }).check();
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.locator(`:text-is("${skuOf("XL")}"):visible`)).toBeVisible();
  await expect(page.locator('[aria-label="Aktif untuk ukuran XL"]:visible')).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/belum aktif/)).toHaveCount(0);
  await expect(page.getByText(/Nonaktif \(/)).toHaveCount(0);
});
