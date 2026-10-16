import { expect, test } from "@playwright/test";
import { E2E_PRODUCT_SLUG, E2E_UNPUBLISHED_PRODUCT_SLUG } from "./storefront-fixtures";

test.describe("/products/[slug]", () => {
  test("renders gallery/price/colours/sizes/keunggulan/accordions at 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Gamis Flowy Straight E2E");
    await expect(page.getByText("Rp269.000")).toBeVisible();
    await expect(page.getByText("Beige E2E", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "S", exact: true })).toBeVisible();
    await expect(page.getByText("Breathable")).toBeVisible();
    await expect(page.getByRole("button", { name: "Deskripsi" })).toHaveAttribute("aria-expanded", "true");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Gamis Flowy Straight E2E");
    await expect(page.getByText("Rp269.000")).toBeVisible();
  });

  test("an unknown or unpublished slug 404s", async ({ page }) => {
    const unknown = await page.goto("/products/does-not-exist-e2e");
    expect(unknown?.status()).toBe(404);

    const unpublished = await page.goto(`/products/${E2E_UNPUBLISHED_PRODUCT_SLUG}`);
    expect(unpublished?.status()).toBe(404);
  });

  test("switching colour updates the gallery and the URL's ?color=, via replace (not push)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Gamis Flowy Straight E2E/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/products/${E2E_PRODUCT_SLUG}$`));

    const mobileGallery = page.locator(".md\\:hidden img").first();
    await expect(mobileGallery).toHaveAttribute("alt", "Gamis Flowy Straight Beige");

    await page.getByRole("button", { name: "Navy E2E" }).click();
    await expect(page).toHaveURL(/\?color=/);
    await expect(mobileGallery).toHaveAttribute("alt", "Gamis Flowy Straight Navy");

    // "replace", not "push" — going back once must leave the PDP entirely (back to "/"), not land
    // on an earlier ?color= state of the same page.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test("size selection: an in-stock size is selectable, an out-of-stock size is disabled and labelled 'habis'", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    const sizeL = page.getByRole("button", { name: "L, habis", exact: true });
    await expect(sizeL).toBeDisabled();

    const sizeS = page.getByRole("button", { name: "S", exact: true });
    await sizeS.click();
    await expect(page.getByText("Ukuran: S")).toBeVisible();

    // The WhatsApp CTA's prefilled message picks up the chosen size (lib/whatsapp.ts).
    const whatsapp = page.getByRole("link", { name: /Tanya via WhatsApp/ });
    const href = await whatsapp.getAttribute("href");
    expect(decodeURIComponent(href ?? "")).toContain("Ukuran S");
  });

  test("accordions: Deskripsi is open by default, keyboard (Enter) toggles another panel and closes it", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    const deskripsi = page.getByRole("button", { name: "Deskripsi" });
    const perawatan = page.getByRole("button", { name: "Perawatan" });
    await expect(deskripsi).toHaveAttribute("aria-expanded", "true");
    await expect(perawatan).toHaveAttribute("aria-expanded", "false");

    await perawatan.focus();
    await page.keyboard.press("Enter");
    await expect(perawatan).toHaveAttribute("aria-expanded", "true");
    // Only one open at a time.
    await expect(deskripsi).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    await expect(perawatan).toHaveAttribute("aria-expanded", "false");
  });

  test("the WhatsApp CTA is the primary action while the cart flag is off (the shipped default)", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await expect(page.getByRole("button", { name: /Tambah ke keranjang|Pilih ukuran/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeVisible();
  });
});
