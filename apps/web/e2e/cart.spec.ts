import { expect, test, type Page } from "@playwright/test";
import {
  E2E_PARTIAL_STOCK_PRODUCT_SLUG,
  E2E_PRODUCT_NAME,
  E2E_PRODUCT_SLUG,
  E2E_RELATED_PRODUCT_SLUG,
  E2E_SOLD_OUT_PRODUCT_NAME,
  E2E_SOLD_OUT_PRODUCT_SLUG,
  E2E_UNPUBLISHED_PRODUCT_NAME,
  E2E_UNPUBLISHED_SKU,
} from "./storefront-fixtures";
import { CART_E2E } from "./helpers/cart-flag";
import { findSku, seedGuestCart } from "./helpers/cart-db";

// docs/plans/cart-checkout.md session 6 (§4.2): the PDP "Tambah ke keranjang", the header cart
// count and /cart, at 390px and 1280px (/cart is a list page: CLAUDE.md requires both). The cart
// tests run under `pnpm test:e2e:cart`; the flag-off tests under the default `pnpm test:e2e`.
// Fixture stock (storefront-fixtures.ts): Flowy Beige S 5 / M 5, Navy M 3; Outer Taupe M 4;
// "Stok Sebagian" Sage M 4; "Habis" Sage M 0; the unpublished product's Beige M 2.

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

function cartLink(page: Page) {
  return page.locator("header").getByRole("link", { name: /^Keranjang/ });
}

function line(page: Page, text: string | RegExp) {
  return page.getByTestId("cart-line").filter({ hasText: text });
}

test.describe("cart flag off (the shipped default)", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  for (const viewport of VIEWPORTS) {
    test(`no cart icon, /cart and the count route are not found, the PDP has no cart button (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      await expect(page.getByRole("link", { name: "Akun saya" })).toBeVisible();
      await expect(cartLink(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Tambah ke keranjang|Pilih ukuran/ })).toHaveCount(0);

      const cartPage = await page.goto("/cart");
      expect(cartPage?.status()).toBe(404);
      const count = await page.request.get("/api/cart/count");
      expect(count.status()).toBe(404);
    });
  }
});

test.describe("cart flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  for (const viewport of VIEWPORTS) {
    test(`PDP add, header count, "Lihat" to /cart, stepper and remove (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang");

      const add = page.getByRole("button", { name: "Pilih ukuran" });
      await expect(add).toBeDisabled();
      await page.getByRole("button", { name: "S", exact: true }).click();
      await page.getByRole("button", { name: "Tambah ke keranjang" }).click();

      // The visible box (the screen-reader status repeats the text with the count).
      await expect(page.getByRole("link", { name: "Lihat", exact: true }).locator("xpath=..")).toHaveText("Masuk keranjang: Beige E2E, S · Lihat");
      await expect(page.getByRole("status").filter({ hasText: "Masuk keranjang" })).toHaveText("Masuk keranjang: Beige E2E, S. 1 barang di keranjang.");
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 1 barang");
      // WhatsApp stays as the outlined secondary action.
      await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeVisible();

      await page.getByRole("link", { name: "Lihat", exact: true }).click();
      await expect(page).toHaveURL(/\/cart$/);
      await expect(page.getByRole("heading", { name: "Keranjang", level: 1 })).toBeVisible();
      const flowy = line(page, E2E_PRODUCT_NAME);
      await expect(flowy).toContainText("Beige E2E · S");
      await expect(flowy).toContainText("Rp269.000");
      await expect(page.getByText("1 barang", { exact: true })).toBeVisible();
      // Shipping is a subsidy, not free (owner decision 2026-10-21): the buyer's share is shown at checkout.
      const summary = page.getByRole("region", { name: "Ringkasan keranjang" });
      await expect(summary.getByText("Dihitung saat checkout", { exact: true })).toBeVisible();
      await expect(summary.getByText(/gratis/i)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Lanjut ke checkout" })).toHaveAttribute("href", "/checkout");
      await expect(page.getByRole("link", { name: "Lanjut belanja" })).toHaveAttribute("href", "/#koleksi");

      await flowy.getByRole("button", { name: /^Tambah jumlah/ }).click();
      await expect(flowy.getByTestId("cart-line-qty")).toHaveText("Jumlah 2");
      await expect(page.getByTestId("cart-subtotal")).toHaveText("Rp538.000");
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 2 barang");

      await flowy.getByRole("button", { name: /^Hapus/ }).click();
      await expect(page.getByText("Keranjangmu masih kosong.")).toBeVisible();
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang");
    });

    test(`line states: insufficient, sold out and no longer available block checkout; fixing them unblocks it (${viewport.name})`, async ({ page, context, baseURL }) => {
      const [beigeM, navyM, soldOutM] = await Promise.all([
        findSku(E2E_PRODUCT_SLUG, "Beige E2E", "M"),
        findSku(E2E_PRODUCT_SLUG, "Navy E2E", "M"),
        findSku(E2E_SOLD_OUT_PRODUCT_SLUG, "Sage E2E", "M"),
      ]);
      await seedGuestCart(context, baseURL!, [
        { sku: beigeM, qty: 1 },
        { sku: navyM, qty: 5 },
        { sku: soldOutM, qty: 1 },
        { sku: E2E_UNPUBLISHED_SKU, qty: 1 },
      ]);
      await page.setViewportSize(viewport);
      await page.goto("/cart");

      const insufficient = line(page, "Navy E2E");
      await expect(insufficient).toContainText("Stok tidak cukup untuk jumlah ini");
      await expect(insufficient.getByTestId("cart-line-qty")).toHaveText("Jumlah 5");
      // Only lowering is possible on a line that asks for more than is left.
      await expect(insufficient.getByRole("button", { name: /^Tambah jumlah/ })).toBeDisabled();

      const soldOut = line(page, E2E_SOLD_OUT_PRODUCT_NAME);
      await expect(soldOut).toContainText("Habis");
      await expect(soldOut.getByRole("button", { name: /jumlah/ })).toHaveCount(0);
      await expect(soldOut.getByRole("button", { name: /^Hapus/ })).toHaveText("Hapus");

      const unavailable = line(page, E2E_UNPUBLISHED_PRODUCT_NAME);
      await expect(unavailable).toContainText("Tidak tersedia lagi");
      await expect(unavailable.getByRole("button", { name: /jumlah/ })).toHaveCount(0);

      // Subtotal counts only lines that can still be bought (1 + 5 x Rp269.000). 8 pieces in all.
      await expect(page.getByTestId("cart-subtotal")).toHaveText("Rp1.614.000");
      await expect(page.getByText("8 barang", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Lanjut ke checkout" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Lanjut ke checkout" })).toBeDisabled();
      await expect(page.getByTestId("cart-blocked-note")).toBeVisible();
      // Never a stock number: Navy M has 3 left, and apart from prices the line shows no 3.
      expect((await insufficient.innerText()).replace(/Rp[\d.]+/g, "")).not.toMatch(/\b3\b/);

      await soldOut.getByRole("button", { name: /^Hapus/ }).click();
      await expect(soldOut).toHaveCount(0);
      await unavailable.getByRole("button", { name: /^Hapus/ }).click();
      await expect(unavailable).toHaveCount(0);
      await insufficient.getByRole("button", { name: /^Kurangi jumlah/ }).click();
      await expect(insufficient.getByTestId("cart-line-qty")).toHaveText("Jumlah 4");
      await expect(insufficient).toContainText("Stok tidak cukup untuk jumlah ini");
      await insufficient.getByRole("button", { name: /^Kurangi jumlah/ }).click();
      await expect(insufficient.getByTestId("cart-line-qty")).toHaveText("Jumlah 3");
      await expect(insufficient).not.toContainText("Stok tidak cukup");

      await expect(page.getByRole("link", { name: "Lanjut ke checkout" })).toHaveAttribute("href", "/checkout");
      await expect(page.getByTestId("cart-blocked-note")).toHaveCount(0);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 4 barang");
    });

    test(`20 pieces: the cap note shows and no line can be raised (${viewport.name})`, async ({ page, context, baseURL }) => {
      // 20 pieces, every line within its stock, so the cap is the only thing that disables "+".
      const skus = await Promise.all([
        findSku(E2E_PRODUCT_SLUG, "Beige E2E", "S"),
        findSku(E2E_PRODUCT_SLUG, "Beige E2E", "M"),
        findSku(E2E_PRODUCT_SLUG, "Navy E2E", "M"),
        findSku(E2E_RELATED_PRODUCT_SLUG, "Taupe E2E", "M"),
        findSku(E2E_PARTIAL_STOCK_PRODUCT_SLUG, "Sage E2E", "M"),
      ]);
      const qtys = [5, 5, 3, 4, 3];
      await seedGuestCart(context, baseURL!, skus.map((sku, index) => ({ sku, qty: qtys[index]! })));
      await page.setViewportSize(viewport);
      await page.goto("/cart");

      await expect(page.getByText("20 barang", { exact: true })).toBeVisible();
      await expect(page.getByText("Maksimal 20 barang per pesanan.")).toBeVisible();
      const plusButtons = page.getByRole("button", { name: /^Tambah jumlah/ });
      await expect(plusButtons).toHaveCount(5);
      for (const plus of await plusButtons.all()) await expect(plus).toHaveAttribute("aria-disabled", "true");
      // Lowering still works, and a full but valid cart can check out.
      await expect(page.getByRole("button", { name: /^Kurangi jumlah/ }).first()).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("link", { name: "Lanjut ke checkout" })).toHaveAttribute("href", "/checkout");
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 20 barang");
    });

    test(`empty cart: message and a primary button back to the collection (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/cart");
      await expect(page.getByText("Keranjangmu masih kosong.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Lihat koleksi" })).toHaveAttribute("href", "/#koleksi");
      await expect(page.getByRole("button", { name: "Lanjut ke checkout" })).toHaveCount(0);
    });

    test(`header: account then cart at the right edge, nothing overlaps the wordmark (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const header = page.locator("header");
      const logo = (await header.getByRole("link", { name: "Ammari, beranda" }).locator("visible=true").boundingBox())!;
      const account = (await header.getByRole("link", { name: "Akun saya" }).boundingBox())!;
      const cart = (await cartLink(page).boundingBox())!;
      const gutter = viewport.width < 1024 ? 16 : 40;
      expect(viewport.width - (cart.x + cart.width)).toBe(gutter);
      expect(account.x + account.width).toBeLessThanOrEqual(cart.x);
      expect(logo.x + logo.width).toBeLessThan(account.x);
      if (viewport.width < 1024) expect(Math.abs(logo.x + logo.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    });
  }

  test("desktop lays the summary beside the lines, mobile stacks it below", async ({ page, context, baseURL }) => {
    await seedGuestCart(context, baseURL!, [{ sku: await findSku(E2E_PRODUCT_SLUG, "Beige E2E", "S"), qty: 1 }]);
    const summary = page.getByRole("region", { name: "Ringkasan keranjang" });
    const lines = page.getByRole("list", { name: "Barang di keranjang" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/cart");
    let summaryBox = (await summary.boundingBox())!;
    let linesBox = (await lines.boundingBox())!;
    expect(summaryBox.x).toBeGreaterThan(linesBox.x + linesBox.width);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(async () => {
      summaryBox = (await summary.boundingBox())!;
      linesBox = (await lines.boundingBox())!;
      expect(summaryBox.y).toBeGreaterThanOrEqual(linesBox.y + linesBox.height);
    }).toPass();
  });
});
