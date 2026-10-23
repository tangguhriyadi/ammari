import { expect, test, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { seedGuestCart } from "./helpers/cart-db";
import { clearCheckoutRateLimits, latestOrderFor, orderLinesFor, seedCheckoutProduct, seedVoucherFor, setCheckoutDiscount } from "./helpers/checkout-db";
import { takeOtp } from "./helpers/otp";

// docs/plans/product-discount.md session 4 (§6, §8, §10): a discounted product through the cart,
// checkout with the Rp20.000 voucher, the fake payment page, the finish page and the buyer's order
// page, with the plan's worked example: 2 x 279.000 (normal 350.000) + 1 x 299.000, courier
// Rp35.000 minus the Rp20.000 subsidy ("Kecamatan E2E Sedang" of the fake shipping provider),
// voucher Rp20.000 = Rp852.000. Then a discount that ends or starts while the buyer is on the
// checkout page: "Harga, ongkir atau voucher berubah", and the resubmit at the new total. At 390px
// and 1280px; the cart is a list page with one layout, checked at both. Each test seeds its own
// products. The admin order detail is covered by apps/admin/e2e/product-discount.spec.ts.

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

const DRIFT_MESSAGE = "Harga, ongkir atau voucher berubah. Cek ringkasan lagi.";

function uniqueEmail(label: string, testInfo: { project: { name: string } }): string {
  return `${label}-${testInfo.project.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.ammari.test`;
}

async function waitForCheckoutForm(page: Page) {
  await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
}

async function pickSedang(page: Page) {
  await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill("e2e sedang");
  await page.getByRole("option", { name: /Kecamatan E2E Sedang, Kota E2E, Provinsi E2E 40444/ }).click();
  await expect(page.getByTestId("shipping-buyer-amount")).toHaveText("Rp15.000");
}

async function fillAddress(page: Page) {
  await page.getByLabel("Nama penerima").fill("Siti Aminah");
  await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
  await page.getByLabel("Alamat lengkap").fill("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
}

/** Gamis A at Rp350.000 with an active Rp279.000 discount, and Gamis B at Rp299.000. */
async function seedWorkedExample(label: string) {
  const a = await seedCheckoutProduct({ label: `Diskon A ${label}`, price: 350_000 });
  await setCheckoutDiscount(a.slug, { salePrice: 279_000, enabled: true, startsAt: new Date(Date.now() - 60 * 60_000) });
  const b = await seedCheckoutProduct({ label: `Diskon B ${label}`, price: 299_000 });
  return { a, b };
}

function lineFor(page: Page, testId: string, name: string) {
  return page.getByTestId(testId).filter({ hasText: name });
}

test.describe("product discount through checkout, flag off (the shipped default)", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  test("no cart or checkout page shows a discounted price", async ({ page }) => {
    expect((await page.goto("/cart"))?.status()).toBe(404);
    expect((await page.goto("/checkout"))?.status()).toBe(404);
  });
});

test.describe("product discount through checkout, flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async () => {
    await clearCheckoutRateLimits();
  });

  for (const viewport of VIEWPORTS) {
    test(`the worked example: cart, checkout with voucher, payment page, finish and order page all show Rp852.000 (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const { a, b } = await seedWorkedExample(viewport.name);
      await seedGuestCart(context, baseURL!, [
        { sku: a.sku, qty: 2 },
        { sku: b.sku, qty: 1 },
      ]);
      const email = uniqueEmail("diskon", testInfo);

      // Cart: the discounted line struck + red, the other plain; subtotal and "Hemat".
      await page.goto("/cart");
      const cartA = lineFor(page, "cart-line", a.name);
      await expect(cartA.getByTestId("line-price-list")).toHaveText("Rp700.000");
      await expect(cartA.getByTestId("line-price-list")).toHaveCSS("text-decoration-line", "line-through");
      await expect(cartA.getByTestId("line-price-sale")).toHaveText("Rp558.000");
      await expect(cartA.getByTestId("line-price-sale")).toHaveCSS("color", "rgb(208, 93, 92)");
      await expect(lineFor(page, "cart-line", b.name).getByTestId("line-price")).toHaveText("Rp299.000");
      await expect(page.getByTestId("cart-subtotal")).toHaveText("Rp857.000");
      await expect(page.getByTestId("cart-savings")).toHaveText("Rp142.000");
      await expect(page.getByTestId("cart-savings").locator("..")).toHaveText(/^\s*Hemat\s*Rp142\.000\s*$/);

      // Checkout, logged in for the voucher.
      await page.getByRole("link", { name: "Lanjut ke checkout" }).click();
      await waitForCheckoutForm(page);
      await page.getByRole("link", { name: "Masuk untuk pakai voucher" }).click();
      await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Kirim kode" }).click();
      await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();
      await page.getByLabel("Kode (6 digit)").fill(await takeOtp(page, email));
      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      await seedVoucherFor(email, 20_000);
      await page.reload();
      await waitForCheckoutForm(page);

      const checkoutA = lineFor(page, "checkout-line", a.name);
      await expect(checkoutA.getByTestId("line-price-list")).toHaveText("Rp700.000");
      await expect(checkoutA.getByTestId("line-price-sale")).toHaveText("Rp558.000");
      await expect(lineFor(page, "checkout-line", b.name).getByTestId("line-price-list")).toHaveCount(0);
      await page.getByLabel("Nomor WhatsApp").fill("0812 7777 9999");
      await fillAddress(page);
      await pickSedang(page);
      await expect(page.getByTestId("summary-subtotal")).toHaveText("Rp857.000");
      await expect(page.getByTestId("summary-savings")).toHaveText("Rp142.000");
      await expect(page.getByTestId("summary-courier-cost")).toHaveText("Rp35.000");
      await expect(page.getByTestId("summary-subsidy")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("summary-shipping")).toHaveText("Rp15.000");
      await expect(page.getByTestId("summary-voucher")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("summary-total")).toHaveText("Rp852.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await page.getByRole("button", { name: "Bayar sekarang" }).click();

      // The gateway's item_details: net prices, Ongkir, Voucher, summing to the total.
      await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-1$/);
      await expect(page.locator(`tr[data-line-id="${a.sku}"]`)).toContainText("Rp558.000");
      await expect(page.locator(`tr[data-line-id="${b.sku}"]`)).toContainText("Rp299.000");
      await expect(page.locator('tr[data-line-id="SHIPPING"]')).toContainText("Rp15.000");
      await expect(page.locator('tr[data-line-id="VOUCHER"]')).toContainText("-Rp20.000");
      await expect(page.getByTestId("fake-payment-total")).toHaveText("Rp852.000");
      const order = await latestOrderFor(email);
      expect(order).toMatchObject({ shippingAmount: 15_000, discountAmount: 20_000, totalAmount: 852_000 });
      expect(await orderLinesFor(email)).toEqual(
        expect.arrayContaining([
          { sku: a.sku, qty: 2, unitPrice: 279_000, listUnitPrice: 350_000 },
          { sku: b.sku, qty: 1, unitPrice: 299_000, listUnitPrice: null },
        ]),
      );

      // The finish page and the buyer's order page show the snapshot.
      await page.getByRole("link", { name: "Kembali ke toko" }).click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Menunggu pembayaran");
      await expect(page.getByTestId("finish-savings")).toHaveText("Rp142.000");
      await expect(page.getByTestId("finish-total")).toHaveText("Rp852.000");

      // The discount ends before the buyer pays: the unpaid order keeps its price.
      await setCheckoutDiscount(a.slug, { salePrice: 279_000, enabled: false });
      await page.goto(`/orders/${order!.orderNo}`);
      const orderLineA = page.getByRole("listitem").filter({ hasText: a.name });
      await expect(orderLineA.getByTestId("line-price-list")).toHaveText("Rp700.000");
      await expect(orderLineA.getByTestId("line-price-sale")).toHaveText("Rp558.000");
      await expect(page.getByTestId("order-savings")).toHaveText("Rp142.000");
      await expect(page.getByTestId("order-total")).toHaveText("Rp852.000");
      await page.getByRole("link", { name: "Lanjutkan pembayaran" }).click();
      await expect(page.getByTestId("fake-payment-total")).toHaveText("Rp852.000");
    });

    for (const direction of ["ends", "starts"] as const) {
      test(`the discount ${direction} while the buyer is on the checkout page: refused, summary re-read, paid at the new total (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
        await page.setViewportSize(viewport);
        const product = await seedCheckoutProduct({ label: `Diskon ${direction} ${viewport.name}`, price: 350_000 });
        await setCheckoutDiscount(product.slug, { salePrice: 279_000, enabled: direction === "ends" });
        await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
        const email = uniqueEmail(`diskon-${direction}`, testInfo);
        const [seen, next] = direction === "ends" ? ["Rp294.000", "Rp365.000"] : ["Rp365.000", "Rp294.000"];

        await page.goto("/checkout");
        await waitForCheckoutForm(page);
        await page.getByLabel("Email").fill(email);
        await page.getByLabel("Nomor WhatsApp").fill("0812 1111 3333");
        await fillAddress(page);
        await pickSedang(page);
        await expect(page.getByTestId("summary-total")).toHaveText(seen);
        if (direction === "ends") await expect(page.getByTestId("summary-savings")).toHaveText("Rp71.000");
        else await expect(page.getByTestId("summary-savings")).toHaveCount(0);

        // The discount flips in the admin while the buyer reads the summary.
        await setCheckoutDiscount(product.slug, { salePrice: 279_000, enabled: direction === "starts" });
        await page.getByLabel(/Saya setuju dengan/).check();
        await page.getByRole("button", { name: "Bayar sekarang" }).click();
        await expect(page.getByTestId("checkout-alert")).toContainText(DRIFT_MESSAGE);
        expect(await latestOrderFor(email)).toBeNull();

        // The page re-reads the cart at the new price and quotes again; paying now goes through.
        await expect(page.getByTestId("summary-total")).toHaveText(next);
        if (direction === "starts") await expect(page.getByTestId("summary-savings")).toHaveText("Rp71.000");
        else await expect(page.getByTestId("summary-savings")).toHaveCount(0);
        await page.getByRole("button", { name: "Bayar sekarang" }).click();
        await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-1$/);
        await expect(page.getByTestId("fake-payment-total")).toHaveText(next);
        expect(await orderLinesFor(email)).toEqual([
          { sku: product.sku, qty: 1, unitPrice: direction === "starts" ? 279_000 : 350_000, listUnitPrice: direction === "starts" ? 350_000 : null },
        ]);
      });
    }
  }
});
