import { expect, test, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { seedGuestCart } from "./helpers/cart-db";
import {
  CHECKOUT_COLOR_NAME,
  clearCheckoutRateLimits,
  countOrdersFor,
  fillRateLimit,
  latestOrderFor,
  orderPaymentStateFor,
  seedCheckoutProduct,
  seedVoucherFor,
  sellOut,
} from "./helpers/checkout-db";
import { takeOtp } from "./helpers/otp";
import { E2E_WHATSAPP_NUMBER } from "./storefront-fixtures";

// docs/plans/cart-checkout.md sessions 10 and 11 (§4.3 to §4.5, §6, §13 "e2e shipping"): the
// checkout page, the area combobox, section 3's states, the summary, "Bayar sekarang", the fake
// payment page, its test buttons (a signed fake notification through the real notification route)
// and the finish page, at 390px and 1280px. The fake shipping provider (fictional "Kecamatan E2E ..."
// areas) and the fake payment provider come from playwright.config.ts; nothing reaches a real
// provider. Each test seeds its own product, so its stock holds never change another spec.
// Murah: courier Rp12.000, buyer Rp0. Jauh: Rp95.000, buyer Rp75.000 (POS Kilat Khusus).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

function uniqueEmail(label: string, testInfo: { project: { name: string } }): string {
  return `${label}-${testInfo.project.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.ammari.test`;
}

async function pickArea(page: Page, query: string, label: RegExp) {
  await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill(query);
  await page.getByRole("option", { name: label }).click();
  await expect(page.getByTestId("picked-area")).toHaveText(label);
}

async function fillGuestForm(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Nomor WhatsApp").fill("0812 1111 2222");
  await fillAddress(page);
}

async function fillAddress(page: Page) {
  await page.getByLabel("Nama penerima").fill("Siti Aminah");
  await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
  await page.getByLabel("Alamat lengkap").fill("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
}

/** Opens /checkout and waits until React has taken over the form (typing earlier is lost). */
async function openCheckout(page: Page) {
  await page.goto("/checkout");
  await waitForCheckoutForm(page);
}

async function waitForCheckoutForm(page: Page) {
  await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
}

function payButton(page: Page) {
  return page.getByRole("button", { name: "Bayar sekarang" });
}

function alertBox(page: Page) {
  return page.getByTestId("checkout-alert");
}

test.describe("checkout, flag off (the shipped default)", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  test("checkout, finish and the fake payment page are not found", async ({ page }) => {
    expect((await page.goto("/checkout"))?.status()).toBe(404);
    expect((await page.goto("/checkout/finish?order=ORD-202610-0001"))?.status()).toBe(404);
    expect((await page.request.get("/api/test/payments/E2E-ORD-202610-0001-1")).status()).toBe(404);
  });
});

test.describe("checkout, flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async () => {
    await clearCheckoutRateLimits();
  });

  for (const viewport of VIEWPORTS) {
    test(`guest: product page to cart to checkout, Rp75.000 ongkir, fake payment page, finish page (${viewport.name})`, async ({ page, browser }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Bayar ${viewport.name}` });
      const email = uniqueEmail("guest", testInfo);

      await page.goto(`/products/${product.slug}`);
      await page.getByRole("button", { name: "M", exact: true }).click();
      await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
      await page.getByRole("link", { name: "Lihat", exact: true }).click();
      await page.getByRole("link", { name: "Lanjut ke checkout" }).click();

      await expect(page).toHaveURL(/\/checkout$/);
      await waitForCheckoutForm(page);
      await expect(page.getByRole("heading", { name: "Checkout", level: 1 })).toBeVisible();
      for (const heading of ["1 · Kontak", "2 · Alamat pengiriman", "3 · Pengiriman", "4 · Ringkasan"]) {
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      }
      await expect(page.getByTestId("checkout-line")).toContainText(product.name);
      await expect(page.getByTestId("checkout-line")).toContainText(`${CHECKOUT_COLOR_NAME} · M · 1×`);
      await expect(page.getByTestId("shipping-row")).toHaveText("Pilih alamat dulu untuk menghitung ongkir.");
      await expect(page.getByTestId("summary-shipping")).toHaveText("-");
      await expect(page.getByRole("link", { name: "Masuk untuk pakai voucher" })).toHaveAttribute("href", "/login?next=%2Fcheckout");
      await expect(page.getByText("Metode pembayaran dipilih di langkah berikutnya: QRIS, virtual account, atau e-wallet.")).toBeVisible();
      // "Bayar sekarang": #F07A1A with #1E1A1A text, 54 px tall (plan §4.3).
      const pay = payButton(page);
      await expect(pay).toHaveCSS("background-color", "rgb(240, 122, 26)");
      await expect(pay).toHaveCSS("color", "rgb(30, 26, 26)");
      expect((await pay.boundingBox())?.height).toBeGreaterThanOrEqual(54);

      await fillGuestForm(page, email);
      await pickArea(page, "e2e jauh", /Kecamatan E2E Jauh, Kabupaten E2E, Provinsi E2E Timur 99111/);
      await expect(page.getByTestId("shipping-row")).toContainText("POS Kilat Khusus");
      await expect(page.getByTestId("shipping-buyer-amount")).toHaveText("Rp75.000");
      // The subsidy in plain sight: courier cost struck through, "Subsidi ongkir Ammari" highlighted.
      await expect(page.getByTestId("shipping-courier-cost")).toHaveText("Rp95.000");
      await expect(page.getByTestId("shipping-courier-cost").locator("s")).toHaveCSS("text-decoration-line", "line-through");
      await expect(page.getByTestId("shipping-subsidy")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("shipping-row")).toContainText("Subsidi ongkir Ammari");
      await expect(page.getByTestId("summary-courier-cost")).toHaveText("Rp95.000");
      await expect(page.getByTestId("summary-subsidy")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("shipping-row")).toContainText("Nomor resi dikirim lewat email setelah pesanan dikirim.");
      await expect(page.getByTestId("summary-subtotal")).toHaveText("Rp250.000");
      await expect(page.getByTestId("summary-shipping")).toHaveText("Rp75.000");
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");

      await page.getByLabel(/Saya setuju dengan/).check();
      await pay.click();

      // The fake payment page: the gateway's view of the charge, with the Ongkir line.
      await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-1$/);
      const order = await latestOrderFor(email);
      expect(order).toMatchObject({ shippingAmount: 75_000, discountAmount: 0, totalAmount: 325_000 });
      await expect(page.getByTestId("fake-payment-order")).toHaveText(order!.orderNo);
      await expect(page.locator('tr[data-line-id="SHIPPING"]')).toContainText("Ongkir");
      await expect(page.locator('tr[data-line-id="SHIPPING"]')).toContainText("Rp75.000");
      await expect(page.getByTestId("fake-payment-total")).toHaveText("Rp325.000");

      // Back to the shop: never "paid" from a browser request.
      await page.getByRole("link", { name: "Kembali ke toko" }).click();
      await expect(page).toHaveURL(new RegExp(`/checkout/finish\\?order=${order!.orderNo}$`));
      await expect(page.getByTestId("finish-heading")).toHaveText("Menunggu pembayaran");
      await expect(page.getByText(/Selesaikan pembayaran sebelum .+ WIB\./)).toBeVisible();
      await expect(page.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", /\/api\/test\/payments\//);
      await expect(page.getByTestId("finish-courier-cost")).toHaveText("Rp95.000");
      await expect(page.getByTestId("finish-subsidy")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("finish-shipping")).toHaveText("Rp75.000");
      await expect(page.getByTestId("finish-total")).toHaveText("Rp325.000");
      // The order emptied the cart: the header count is gone.
      await expect(page.locator("header").getByRole("link", { name: /^Keranjang/ })).toHaveAccessibleName("Keranjang");

      // Another browser (no checkout cookie, no session) learns nothing about the order, not even
      // that it exists: the same "log in" answer as an unknown number.
      const stranger = await browser.newContext();
      const strangerPage = await stranger.newPage();
      for (const orderNo of [order!.orderNo, "ORD-209912-0001"]) {
        await strangerPage.goto(`/checkout/finish?order=${orderNo}`);
        await expect(strangerPage.getByTestId("finish-heading")).toHaveText("Lihat pesanan");
        await expect(strangerPage.getByText("Rp325.000")).toHaveCount(0);
      }
      await stranger.close();

      // Guest: the OTP login with the contact email filled in; it never logs in by itself.
      await page.getByRole("link", { name: "Masuk untuk melihat semua pesanan" }).click();
      await expect(page).toHaveURL(/\/login\?next=%2Forders$/);
      await expect(page.getByLabel("Email")).toHaveValue(email);
    });

    test(`the fake gateway pays through the real notification route: "Pembayaran berhasil", sold (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Lunas ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("lunas", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "40111", /Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111/);
      await expect(page.getByTestId("summary-total")).toHaveText("Rp250.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-1$/);
      // No Ongkir line when the subsidy covers it all (plan §4.5.6).
      await expect(page.locator('tr[data-line-id="SHIPPING"]')).toHaveCount(0);

      await page.getByTestId("fake-payment-pay").click();
      await expect(page).toHaveURL(/\/checkout\/finish\?order=ORD-/);
      await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran berhasil");
      await expect(page.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveCount(0);
      expect(await orderPaymentStateFor(email)).toEqual({ status: "to_ship", paymentStatus: "paid", sales: 1, activeHolds: 0 });
    });

    test(`"Ganti metode pembayaran" opens a new payment page for the same order; paying it sells once (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Ganti ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("ganti", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "40111", /Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111/);
      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-1$/);

      // Back without paying: the finish page offers both the same page and a new one.
      await page.getByRole("link", { name: "Kembali ke toko" }).click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Menunggu pembayaran");
      await expect(page.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", /-1$/);
      await expect(page.getByText("Pembayaran yang belum selesai dengan metode sebelumnya dibatalkan, lalu kamu bisa memilih metode lain.")).toBeVisible();
      await page.getByRole("button", { name: "Ganti metode pembayaran" }).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\/E2E-ORD-\d{6}-\d{4,}-2$/);

      // "Lanjutkan pembayaran" now leads to the new page.
      await page.getByRole("link", { name: "Kembali ke toko" }).click();
      await expect(page.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", /-2$/);
      await page.getByRole("link", { name: "Lanjutkan pembayaran" }).click();
      await page.getByTestId("fake-payment-pay").click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran berhasil");
      await expect(page.getByRole("button", { name: "Ganti metode pembayaran" })).toHaveCount(0);
      expect(await orderPaymentStateFor(email)).toEqual({ status: "to_ship", paymentStatus: "paid", sales: 1, activeHolds: 0 });
    });

    test(`the fake gateway expires the payment: cancelled, holds released, "Pembayaran gagal atau kedaluwarsa" (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Habis waktu ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("kedaluwarsa", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "40111", /Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111/);
      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      expect(await orderPaymentStateFor(email)).toMatchObject({ status: "awaiting_payment", activeHolds: 1 });

      await page.getByTestId("fake-payment-expire").click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran gagal atau kedaluwarsa");
      expect(await orderPaymentStateFor(email)).toEqual({ status: "cancelled", paymentStatus: "expired", sales: 0, activeHolds: 0 });
    });

    test(`area fully covered by the subsidy shows Rp0; an empty submit lists what to fix (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Murah ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 2 }]);
      const email = uniqueEmail("murah", testInfo);

      await openCheckout(page);
      await payButton(page).click();
      const alert = alertBox(page);
      await expect(alert).toBeVisible();
      await expect(alert).toBeFocused();
      for (const message of [
        "Email wajib diisi.",
        "Nomor WhatsApp wajib diisi.",
        "Nama penerima wajib diisi.",
        "Nomor HP penerima wajib diisi.",
        "Pilih kecamatan dari daftar.",
        "Alamat lengkap wajib diisi.",
        "Setujui Syarat & Ketentuan dan Kebijakan privasi untuk melanjutkan.",
      ]) {
        await expect(alert).toContainText(message);
      }
      await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");

      await fillGuestForm(page, email);
      await page.getByLabel("Nomor WhatsApp").fill("021 555 1234");
      await pickArea(page, "40111", /Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111/);
      await expect(page.getByTestId("shipping-row")).toContainText("JNE Reguler");
      await expect(page.getByTestId("shipping-buyer-amount")).toHaveText("Rp0");
      await expect(page.getByTestId("shipping-courier-cost")).toHaveText("Rp12.000");
      await expect(page.getByTestId("shipping-subsidy")).toHaveText("-Rp12.000");
      await expect(page.getByTestId("shipping-row")).toContainText("Gratis ongkir");
      await expect(page.getByTestId("summary-shipping")).toHaveText("Rp0");
      await expect(page.getByTestId("summary-total")).toHaveText("Rp500.000");

      // A landline is refused before anything is sent.
      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(alert).toContainText("Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.");
      expect(await countOrdersFor(email)).toBe(0);

      // "Ganti" brings the search back.
      await page.getByRole("button", { name: /Ganti kecamatan/ }).click();
      await expect(page.getByRole("combobox", { name: "Kecamatan atau kode pos" })).toBeFocused();
      await expect(page.getByTestId("shipping-row")).toHaveText("Pilih alamat dulu untuk menghitung ongkir.");
    });

    test(`shipping provider down: retry message, "Coba lagi", payment refused (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Gangguan ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("down", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "e2e gangguan", /Kecamatan E2E Gangguan/);
      await expect(page.getByTestId("shipping-error")).toContainText("Ongkir belum bisa dihitung. Coba lagi sebentar lagi.");
      await expect(page.getByTestId("summary-shipping")).toHaveText("-");
      await page.getByRole("button", { name: "Coba lagi" }).click();
      await expect(page.getByTestId("shipping-error")).toContainText("Ongkir belum bisa dihitung. Coba lagi sebentar lagi.");

      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(alertBox(page)).toContainText("Ongkir belum bisa dihitung. Coba lagi sebentar lagi.");
      expect(await countOrdersFor(email)).toBe(0);
    });

    test(`no service to the area: WhatsApp link with the area, payment refused (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Tanpa Layanan ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("noservice", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "tanpa layanan", /Kecamatan E2E Tanpa Layanan/);
      await expect(page.getByTestId("shipping-error")).toContainText(
        "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp.",
      );
      const whatsapp = page.getByRole("link", { name: "Hubungi via WhatsApp" });
      await expect(whatsapp).toHaveAttribute("href", new RegExp(`^https://wa\\.me/${E2E_WHATSAPP_NUMBER}\\?text=.*Kecamatan%20E2E%20Tanpa%20Layanan`));

      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();
      await expect(alertBox(page)).toContainText("Pengiriman ke alamat ini belum tersedia lewat website.");
      expect(await countOrdersFor(email)).toBe(0);
    });

    test(`a product without a shipping weight cannot be quoted (${viewport.name})`, async ({ page, context, baseURL }) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Tanpa Berat ${viewport.name}`, weightGrams: null });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);

      await openCheckout(page);
      await pickArea(page, "e2e murah", /Kecamatan E2E Murah/);
      await expect(page.getByTestId("shipping-error")).toContainText("Ongkir belum bisa dihitung untuk pesanan ini. Hubungi kami lewat WhatsApp.");
      await expect(page.getByRole("link", { name: "Hubungi via WhatsApp" })).toBeVisible();
    });

    test(`logged in: locked contact, best voucher picked, Voucher line reaches the payment page (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Voucher ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("voucher", testInfo);

      await openCheckout(page);
      await page.getByRole("link", { name: "Masuk untuk pakai voucher" }).click();
      await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Kirim kode" }).click();
      await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();
      await page.getByLabel("Kode (6 digit)").fill(await takeOtp(page, email));
      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      // The guest cart merged into the account's on the way back.
      await expect(page.getByTestId("checkout-line")).toContainText(product.name);

      await seedVoucherFor(email, 20_000);
      await page.reload();
      await waitForCheckoutForm(page);
      await expect(page.getByTestId("locked-email")).toHaveText(email);
      await expect(page.getByRole("button", { name: "Bukan kamu? Keluar" })).toBeVisible();
      await expect(page.getByLabel("Email")).toHaveCount(0);
      const voucherSelect = page.getByLabel("Voucher", { exact: true });
      await expect(voucherSelect.locator("option:checked")).toHaveText(/^Voucher Rp20\.000, berlaku sampai/);
      await expect(page.getByTestId("summary-voucher")).toHaveText("-Rp20.000");

      // × clears it, and it can be picked again.
      await page.getByRole("button", { name: "Hapus voucher" }).click();
      await expect(page.getByTestId("summary-voucher")).toHaveCount(0);
      await voucherSelect.selectOption({ index: 1 });
      await expect(page.getByTestId("summary-voucher")).toHaveText("-Rp20.000");

      // A new account has no phone yet: it is typed here.
      await page.getByLabel("Nomor WhatsApp").fill("0812 7777 8888");
      await fillAddress(page);
      await pickArea(page, "e2e jauh", /Kecamatan E2E Jauh/);
      await expect(page.getByTestId("summary-total")).toHaveText("Rp305.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await payButton(page).click();

      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      await expect(page.locator('tr[data-line-id="VOUCHER"]')).toContainText("-Rp20.000");
      await expect(page.locator('tr[data-line-id="SHIPPING"]')).toContainText("Rp75.000");
      await expect(page.getByTestId("fake-payment-total")).toHaveText("Rp305.000");
      await page.getByRole("link", { name: "Kembali ke toko" }).click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Menunggu pembayaran");
      // Logged in: no login prompt.
      await expect(page.getByRole("link", { name: "Masuk untuk melihat semua pesanan" })).toHaveCount(0);
    });

    test(`the last piece sells out while the buyer is on the checkout page (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Terakhir ${viewport.name}`, stock: 1 });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("soldout", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "e2e murah", /Kecamatan E2E Murah/);
      await page.getByLabel(/Saya setuju dengan/).check();
      await sellOut(product.sku);
      await payButton(page).click();

      await expect(alertBox(page)).toContainText(product.name);
      // The page re-reads the cart: the sold-out line now sends the buyer back to the cart.
      await expect(page.getByText("Ada barang di keranjang yang perlu dicek dulu sebelum checkout.")).toBeVisible();
      await expect(alertBox(page)).toContainText(product.name);
      await expect(page).toHaveURL(/\/checkout$/);
      expect(await countOrdersFor(email)).toBe(0);
    });

    test(`limits: too many submits and too many quotes from one address (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Batas ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: product.sku, qty: 1 }]);
      const email = uniqueEmail("limit", testInfo);

      await openCheckout(page);
      await fillGuestForm(page, email);
      await pickArea(page, "e2e murah", /Kecamatan E2E Murah/);
      await page.getByLabel(/Saya setuju dengan/).check();

      await fillRateLimit("checkout_submit", 10);
      await payButton(page).click();
      await expect(alertBox(page)).toContainText("Terlalu banyak percobaan. Coba lagi beberapa menit lagi.");
      expect(await countOrdersFor(email)).toBe(0);

      await fillRateLimit("shipping_quote", 30);
      await page.getByRole("button", { name: /Ganti kecamatan/ }).click();
      await pickArea(page, "e2e jauh", /Kecamatan E2E Jauh/);
      await expect(page.getByTestId("shipping-error")).toContainText("Terlalu banyak percobaan hitung ongkir. Coba lagi beberapa menit lagi.");
    });
  }
});
