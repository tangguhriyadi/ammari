import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { clearCheckoutRateLimits, latestOrderFor, orderPaymentStateFor, seedCheckoutProduct } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer, type LinkCustomer } from "./helpers/login-link-db";
import { customerCartLines, issueViewToken, seedCheckoutOrder } from "./helpers/orders-db";

// Owner feedback 2026-10-22 (lib/auth/sign-out.ts): a logout starts the browser fresh. After it the
// cart is empty, the "menunggu pembayaran" reminder is gone and no order page opens without a login,
// while the order, its payment and the account's cart all stay: the cart is back on the next login.
// Fake shipping and payment providers only (playwright.config.ts).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

const NOT_FOUND = "Pesanan tidak bisa ditampilkan";
/** Every cookie a logout must leave behind on this browser. */
const DEVICE_COOKIE = /^(ammari_cart|ammari_checkout_order(_v2)?|ammari_order_views?(_.*)?)$/;

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

async function addToCart(page: Page, slug: string): Promise<void> {
  await page.goto(`/products/${slug}`);
  await page.getByRole("button", { name: "M", exact: true }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Masuk keranjang" })).toContainText("Masuk keranjang");
}

function cartLink(page: Page) {
  return page.getByRole("banner").getByRole("link", { name: /^Keranjang/ });
}

async function deviceCookies(context: BrowserContext): Promise<string[]> {
  return (await context.cookies()).map((cookie) => cookie.name).filter((name) => DEVICE_COOKIE.test(name));
}

test.describe("logout starts the browser fresh, flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async ({ context }) => {
    await clearCheckoutRateLimits();
    await ownIp(context);
  });

  for (const viewport of VIEWPORTS) {
    test(`guest cart, login, unpaid order, "Lihat pesanan" link, logout: nothing shows; the next login brings the cart back (${viewport.name})`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      const customer = await seedLinkCustomer(`keluar-${viewport.name.replace("px", "")}`);
      const ordered = await seedCheckoutProduct({ label: `Keluar Pesan ${viewport.name}` });
      const kept = await seedCheckoutProduct({ label: `Keluar Simpan ${viewport.name}` });

      // A guest cart, merged into the account at login.
      await addToCart(page, ordered.slug);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 1 barang");
      await login(page, customer);
      await page.goto("/cart");
      await expect(page.getByText(ordered.name)).toBeVisible();

      // An unpaid order, left on the payment page.
      await page.goto("/checkout");
      await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
      await page.getByLabel("Nomor WhatsApp").fill("0812 7777 8888");
      await page.getByLabel("Nama penerima").fill("Siti Aminah");
      await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
      await page.getByLabel("Alamat lengkap").fill("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
      await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill("e2e jauh");
      await page.getByRole("option", { name: /Kecamatan E2E Jauh/ }).click();
      await expect(page.getByTestId("shipping-buyer-amount")).toHaveText("Rp75.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await page.getByRole("button", { name: "Bayar sekarang" }).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      const order = await latestOrderFor(customer.email);
      expect(order).not.toBeNull();
      await page.goto("/cart");
      await expect(page.getByTestId("pending-order-banner")).toContainText(order!.orderNo);

      // Another order opened from an email's "Lihat pesanan" link.
      const emailed = await seedCheckoutOrder({ customerId: null, email: `lain-${customer.email}`, placedWithSession: false, lines: [{ sku: kept.sku, qty: 1, unitPrice: 250_000 }], state: "pending" });
      await page.goto(`/orders/${emailed.orderNo}?t=${await issueViewToken(emailed.id)}`);
      await expect(page.getByTestId("order-status")).toHaveText("Menunggu pembayaran");

      // The account's cart after the order: one more line.
      await addToCart(page, kept.slug);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 1 barang");
      expect(await deviceCookies(context)).toEqual(expect.arrayContaining(["ammari_checkout_order_v2", `ammari_order_view_${emailed.orderNo}`, "ammari_order_views"]));

      await page.goto("/account");
      await expect(cartLink(page).getByTestId("cart-count")).toHaveText("1");
      await page.getByRole("button", { name: "Keluar" }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang");
      await expect(cartLink(page).getByTestId("cart-count")).toHaveCount(0);
      expect(await deviceCookies(context)).toEqual([]);

      // Nothing of the previous person shows.
      await page.goto("/cart");
      await expect(page.getByText(kept.name)).toHaveCount(0);
      await expect(page.getByTestId("pending-order-banner")).toHaveCount(0);
      await page.goto(`/products/${ordered.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: ordered.name })).toBeVisible();
      await expect(page.getByTestId("pending-order-banner")).toHaveCount(0);
      expect(await (await page.request.get("/api/checkout/pending-order")).json()).toEqual({ order: null });
      for (const orderNo of [order!.orderNo, emailed.orderNo]) {
        await page.goto(`/orders/${orderNo}`);
        await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);
      }

      // Nothing was deleted: the order still waits for its payment, the account keeps its cart.
      expect(await orderPaymentStateFor(customer.email)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect(await customerCartLines(customer.id)).toEqual({ [kept.sku]: 1 });

      // The next login: the account's cart is back.
      await login(page, customer);
      await expect(cartLink(page)).toHaveAccessibleName("Keranjang, 1 barang");
      await page.goto("/cart");
      await expect(page.getByText(kept.name)).toBeVisible();
    });
  }

  test(`"Bukan kamu? Keluar" on the checkout clears the cart the same way`, async ({ page, context }) => {
    const customer = await seedLinkCustomer("keluar-checkout");
    const product = await seedCheckoutProduct({ label: "Keluar Checkout" });
    await addToCart(page, product.slug);
    await login(page, customer);

    await page.goto("/checkout");
    await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
    await expect(cartLink(page).getByTestId("cart-count")).toHaveText("1");
    await page.getByRole("button", { name: "Bukan kamu? Keluar" }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
    await expect(cartLink(page).getByTestId("cart-count")).toHaveCount(0);
    expect(await deviceCookies(context)).toEqual([]);
    await page.goto("/cart");
    await expect(page.getByText(product.name)).toHaveCount(0);
    expect(await customerCartLines(customer.id)).toEqual({ [product.sku]: 1 });
  });
});
