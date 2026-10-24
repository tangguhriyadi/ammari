import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { addVariants, createProductDraft, openProductStep, stepItem, type ProductStep } from "./helpers/product";
import { jpegFixture } from "./helpers/publishable-product";
import { E2E_PRODUCT_STEPPER_EMAIL } from "./global-setup";

// docs/plans/product-stepper.md: the 5-step product wizard. Create mode (forward steps locked
// until the ones before are done, Lanjut saves, Lewati skips) and edit mode (every step opens
// directly, ?step= links, unsaved-changes dialog), plus the step bar's states and layouts, at
// both 390px and 1280px.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAV = { timeout: 15_000 };

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/, NAV);
}

function stepBar(page: Page): Locator {
  return page.getByRole("navigation", { name: "Langkah produk" });
}

function footer(page: Page): Locator {
  return page.getByTestId("product-step-footer");
}

async function expectStepOpen(page: Page, step: ProductStep): Promise<void> {
  await expect(page.getByTestId("product-step-content")).toHaveAttribute("data-step", step, NAV);
  await expect(stepItem(page, step)).toHaveAttribute("aria-current", "step");
}

/** sr-only text is "visible" to Playwright, so check the size of its sr-only wrapper (1px). */
async function expectVisuallyHidden(locator: Locator): Promise<void> {
  const width = await locator.evaluate((element) => (element.closest(".sr-only") ?? element).getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(1);
}

async function expectLocked(page: Page, step: ProductStep): Promise<void> {
  const item = stepItem(page, step);
  await expect(item).toHaveAttribute("data-locked", "");
  // A plain item, not a link: not focusable, and it says why.
  expect(await item.evaluate((element) => element.tagName)).toBe("SPAN");
  await expect(item).toContainText("terkunci, selesaikan langkah sebelumnya dulu");
}

for (const viewport of [
  { label: "390px", width: 390, height: 844 },
  { label: "1280px", width: 1280, height: 900 },
] as const) {
  const isPhone = viewport.width < 1024;

  test.describe(`product stepper at ${viewport.label}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await loginAs(page, E2E_PRODUCT_STEPPER_EMAIL);
    });

    test("create: full path through all 5 steps, Lanjut saves each step, the draft stays off the storefront", async ({ page }) => {
      const unique = `${viewport.label}-${Date.now()}`;
      const fabricName = `E2E Bahan Stepper ${unique}`;
      const productName = `Contoh Gamis Stepper ${unique}`;
      await createFabric(page, fabricName);

      // Step bar before the product exists: step 1 current, every other step locked.
      await page.goto("/products/new");
      await expect(stepItem(page, "info")).toHaveAttribute("aria-current", "step");
      await expect(stepItem(page, "info")).toHaveAttribute("data-status", "current");
      await expect(stepBar(page).getByRole("link")).toHaveCount(0);
      for (const step of ["varian", "foto", "toko", "aksesoris"] as const) await expectLocked(page, step);
      if (isPhone) {
        await expect(stepBar(page).getByTestId("step-position")).toHaveText("Langkah 1 dari 5 · Info produk");
        await expectVisuallyHidden(stepBar(page).getByText("Warna dan ukuran"));
      } else {
        await expect(stepBar(page).getByTestId("step-position")).toBeHidden();
        await expect(stepBar(page).getByText("Info dasar, harga, diskon")).toBeVisible();
        await expect(stepBar(page).getByText("Warna dan ukuran")).toBeVisible();
      }

      // Step 1 -> saved as a draft, on to step 2.
      const { productId } = await createProductDraft(page, { name: productName, fabricName, shippingWeightGrams: "800" });
      await expect(page.getByRole("status")).toContainText("Produk tersimpan sebagai draf");
      await expectStepOpen(page, "varian");
      await expect(stepItem(page, "info")).toHaveAttribute("data-status", "done");
      await expect(stepBar(page).getByRole("link", { name: /Info produk/ })).toBeVisible();
      for (const step of ["foto", "toko", "aksesoris"] as const) await expectLocked(page, step);
      if (isPhone) await expect(stepBar(page).getByTestId("step-position")).toHaveText("Langkah 2 dari 5 · Varian");

      // Varian has no Lewati and needs at least one variant.
      await expect(footer(page).getByRole("button", { name: "Lewati" })).toHaveCount(0);
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expect(footer(page).getByRole("alert")).toHaveText("Tambah minimal satu varian sebelum lanjut.");
      await expectStepOpen(page, "varian");

      // Ticked but not added yet: Lanjut adds them, then moves on.
      await page.getByRole("checkbox", { name: /Sage/ }).check();
      await page.getByRole("checkbox", { name: "M", exact: true }).check();
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expect(page).toHaveURL(new RegExp(`/products/${productId}/setup\\?step=foto&reached=foto$`), NAV);
      await expectStepOpen(page, "foto");
      await expect(stepItem(page, "varian")).toHaveAttribute("data-status", "done");

      // Foto: a staged photo is uploaded by Lanjut.
      const sageGroup = page.locator('[data-testid^="photo-group-"]').filter({ has: page.getByRole("heading", { name: "Sage", exact: true }) });
      await sageGroup.locator('input[type="file"]').setInputFiles({ name: "sage.jpg", mimeType: "image/jpeg", buffer: await jpegFixture() });
      await expect(sageGroup.getByTestId("pending-photo-tile")).toHaveCount(1);
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expectStepOpen(page, "toko");

      // Toko online: the description is saved by Lanjut. Not published (the owner didn't switch it on).
      const storefront = page.getByTestId("storefront-section");
      await expect(storefront.getByRole("switch", { name: "Tayang di toko online" })).toHaveAttribute("aria-checked", "false");
      await page.getByTestId("storefront-description-editor").click();
      await page.keyboard.type("Gamis adem untuk harian.");
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expectStepOpen(page, "aksesoris");
      await expect(footer(page).getByRole("button", { name: "Lewati" })).toBeVisible();

      // Kembali keeps every step already reached open.
      await footer(page).getByRole("button", { name: "Kembali" }).click();
      await expectStepOpen(page, "toko");
      await expect(page.getByTestId("storefront-description-editor")).toContainText("Gamis adem untuk harian.");
      await expect(stepItem(page, "aksesoris")).not.toHaveAttribute("data-locked", "");

      // Back to step 1 of the draft: the discount is available now that the product is saved.
      await stepItem(page, "info").click();
      await expectStepOpen(page, "info");
      await expect(page.getByTestId("discount-section")).toBeVisible();
      await expect(page.getByLabel("Nama produk")).toHaveValue(productName);

      // Jump forward to the furthest step reached, and finish.
      await stepItem(page, "aksesoris").click();
      await expectStepOpen(page, "aksesoris");
      await footer(page).getByRole("button", { name: "Selesai" }).click();
      await expect(page).toHaveURL(new RegExp(`/products/${productId}$`), NAV);
      await expect(page.getByRole("status")).toContainText("Produk berhasil disimpan");

      // The edit page: every step open, done marks from the saved data, still a draft.
      await expectStepOpen(page, "info");
      await expect(stepBar(page).getByRole("link")).toHaveCount(4);
      await expect(stepItem(page, "foto")).toHaveAttribute("data-status", "done");
      await expect(stepItem(page, "toko")).toHaveAttribute("data-status", "upcoming");
      await openProductStep(page, productId, "foto");
      await expect(sageGroup.getByTestId("photo-tile")).toHaveCount(1);
      await openProductStep(page, productId, "toko");
      await expect(storefront.getByRole("switch", { name: "Tayang di toko online" })).toHaveAttribute("aria-checked", "false");
      await expect(page.getByTestId("storefront-description-editor")).toContainText("Gamis adem untuk harian.");
    });

    test("create: Foto, Toko online and Aksesoris can be skipped; a forward jump is blocked", async ({ page }) => {
      const unique = `${viewport.label}-${Date.now()}`;
      const fabricName = `E2E Bahan Lewati ${unique}`;
      await createFabric(page, fabricName);
      const { productId } = await createProductDraft(page, { name: `Contoh Gamis Lewati ${unique}`, fabricName });

      // A hand-typed later step falls back to the furthest step allowed (no variant yet: Varian).
      await page.goto(`/products/${productId}/setup?step=aksesoris&reached=aksesoris`);
      await expect(page).toHaveURL(new RegExp(`/products/${productId}/setup\\?step=varian&reached=varian$`), NAV);
      await expectLocked(page, "foto");

      await addVariants(page, /Sage/, ["M", "L"]);
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expectStepOpen(page, "foto");
      // Skipped steps beyond the current one stay locked until reached.
      await expectLocked(page, "toko");
      await page.goto(`/products/${productId}/setup?step=aksesoris&reached=foto`);
      await expect(page).toHaveURL(new RegExp(`/products/${productId}/setup\\?step=foto&reached=foto$`), NAV);

      await footer(page).getByRole("button", { name: "Lewati" }).click();
      await expectStepOpen(page, "toko");
      await footer(page).getByRole("button", { name: "Lewati" }).click();
      await expectStepOpen(page, "aksesoris");
      await footer(page).getByRole("button", { name: "Lewati" }).click();
      await expect(page).toHaveURL(new RegExp(`/products/${productId}$`), NAV);
      await expectStepOpen(page, "info");
    });

    test("create: leaving midway keeps everything saved; the owner continues from the edit page", async ({ page }) => {
      const unique = `${viewport.label}-${Date.now()}`;
      const fabricName = `E2E Bahan Lanjut Nanti ${unique}`;
      const productName = `Contoh Gamis Lanjut Nanti ${unique}`;
      await createFabric(page, fabricName);
      await createProductDraft(page, { name: productName, fabricName });
      await addVariants(page, /Sage/, ["S"]);

      // Leave for the product list, then open the product again the way the owner would.
      await page.goto(`/products?q=${encodeURIComponent(productName)}`);
      await page.locator("main a:visible").filter({ hasText: productName }).first().click();
      await expect(page).toHaveURL(new RegExp(`/products/${UUID}$`), NAV);

      // Edit mode: step 1 first, every step can be opened, saved data marked done.
      await expectStepOpen(page, "info");
      await expect(page.getByLabel("Nama produk")).toHaveValue(productName);
      await expect(stepBar(page).getByRole("link")).toHaveCount(4);
      await expect(stepItem(page, "varian")).toHaveAttribute("data-status", "done");
      await expect(stepItem(page, "foto")).toHaveAttribute("data-status", "upcoming");
      await expect(footer(page).getByRole("button", { name: "Lewati" })).toHaveCount(0);

      await stepItem(page, "aksesoris").click();
      await expectStepOpen(page, "aksesoris");
      await expect(page).toHaveURL(/\?step=aksesoris$/);
      await stepItem(page, "varian").click();
      await expectStepOpen(page, "varian");
      await expect(page.getByText("Belum ada varian aktif.")).toHaveCount(0);
    });

    test("edit: ?step= opens a step directly, old links land on step 1, unsaved changes ask before switching", async ({ page }) => {
      const unique = `${viewport.label}-${Date.now()}`;
      const fabricName = `E2E Bahan Edit Langkah ${unique}`;
      const productName = `Contoh Gamis Edit Langkah ${unique}`;
      await createFabric(page, fabricName);
      const { productId } = await createProductDraft(page, { name: productName, fabricName });
      await addVariants(page, /Sage/, ["M"]);

      // A link straight into a step.
      await page.goto(`/products/${productId}?step=foto`);
      await expectStepOpen(page, "foto");
      await expect(page.getByRole("heading", { name: "Foto", exact: true })).toBeVisible();
      // An unknown step and the old Indonesian path both open step 1.
      await page.goto(`/products/${productId}?step=nope`);
      await expectStepOpen(page, "info");
      await page.goto(`/produk/${productId}`);
      await expect(page).toHaveURL(new RegExp(`/products/${productId}$`), NAV);
      await expectStepOpen(page, "info");

      // Edit mode's Lanjut/Kembali only move (nothing unsaved here).
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expectStepOpen(page, "varian");
      await footer(page).getByRole("button", { name: "Kembali" }).click();
      await expectStepOpen(page, "info");

      // Unsaved change + step click: the in-page dialog asks (no browser confirm).
      let browserDialog = false;
      page.on("dialog", (dialog) => {
        browserDialog = true;
        void dialog.dismiss();
      });
      await page.getByLabel("Nama produk").fill(`${productName} Baru`);
      await stepItem(page, "varian").click();
      const confirm = page.getByRole("dialog", { name: "Ada perubahan yang belum disimpan" });
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Tetap di sini" }).click();
      await expect(confirm).toBeHidden();
      await expectStepOpen(page, "info");
      await expect(page.getByLabel("Nama produk")).toHaveValue(`${productName} Baru`);

      // Lanjut asks too; discarding moves on and nothing was saved.
      await footer(page).getByRole("button", { name: "Lanjut" }).click();
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Buang perubahan" }).click();
      await expectStepOpen(page, "varian");
      await stepItem(page, "info").click();
      await expectStepOpen(page, "info");
      await expect(page.getByLabel("Nama produk")).toHaveValue(productName);

      // Staged photos count as unsaved too (and the stepper's own dialog replaces window.confirm).
      await stepItem(page, "foto").click();
      await expectStepOpen(page, "foto");
      await page.getByTestId("photo-group-general").locator('input[type="file"]').setInputFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: await jpegFixture() });
      await expect(page.getByTestId("photo-group-general").getByTestId("pending-photo-tile")).toHaveCount(1);
      await stepItem(page, "toko").click();
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Tetap di sini" }).click();
      await expectStepOpen(page, "foto");
      expect(browserDialog).toBe(false);
    });
  });
}
