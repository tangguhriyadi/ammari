import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { clearCheckoutRateLimits, latestOrderFor, seedCheckoutProduct } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer, type LinkCustomer } from "./helpers/login-link-db";

// Second round of the owner's 2026-10-21 sandbox fixes (docs/plans/cart-checkout.md §4.3, §4.4):
// "Beli sekarang" on the product page, the "menunggu pembayaran" reminder after leaving the payment
// page with the back button, and the saved address of a logged-in buyer. Fake shipping and payment
// providers only (playwright.config.ts).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

function uniqueEmail(label: string, testInfo: { project: { name: string } }): string {
  return `${label}-${testInfo.project.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.ammari.test`;
}

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function waitForCheckoutForm(page: Page) {
  await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
}

async function pickArea(page: Page, query: string, label: RegExp) {
  await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill(query);
  await page.getByRole("option", { name: label }).click();
  await expect(page.getByTestId("picked-area")).toHaveText(label);
}

async function fillAddress(page: Page, name = "Siti Aminah") {
  await page.getByLabel("Nama penerima").fill(name);
  await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
  await page.getByLabel("Alamat lengkap").fill("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

test.describe("product page buttons, flag off (the shipped default)", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  test("no Beli sekarang; WhatsApp stays the main button; no pending-order read", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    const product = await seedCheckoutProduct({ label: "Tombol Off" });
    await page.goto(`/products/${product.slug}`);
    await page.getByRole("button", { name: "M", exact: true }).click();
    await expect(page.getByRole("button", { name: "Beli sekarang" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tambah ke keranjang" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Tanya via WhatsApp" })).toHaveCSS("background-color", "rgb(105, 90, 90)");
    expect((await page.request.get("/api/checkout/pending-order")).status()).toBe(404);
    expect(requests).not.toContain("/api/checkout/pending-order");
  });
});

test.describe("return to payment and Beli sekarang, flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async ({ context }) => {
    await clearCheckoutRateLimits();
    await ownIp(context);
  });

  for (const viewport of VIEWPORTS) {
    test(`Beli sekarang goes to checkout; back from the payment page the order waits on /checkout, /cart and its product page (${viewport.name})`, async ({ page, browser }, testInfo) => {
      await page.setViewportSize(viewport);
      const product = await seedCheckoutProduct({ label: `Beli ${viewport.name}`, stock: 1 });
      const other = await seedCheckoutProduct({ label: `Lain ${viewport.name}` });
      const email = uniqueEmail("kembali", testInfo);

      await page.goto(`/products/${product.slug}`);
      await expect(page.getByRole("button", { name: "Pilih ukuran" })).toBeDisabled();
      await page.getByRole("button", { name: "M", exact: true }).click();
      const buy = page.getByRole("button", { name: "Beli sekarang" });
      await expect(buy).toHaveCSS("background-color", "rgb(105, 90, 90)");
      await expect(page.getByRole("button", { name: "Tambah ke keranjang" })).toHaveCSS("border-top-style", "solid");
      await expect(page.getByRole("link", { name: "Tanya via WhatsApp" })).toHaveCSS("text-decoration-line", "underline");
      await buy.click();

      await expect(page).toHaveURL(/\/checkout$/);
      await waitForCheckoutForm(page);
      await expect(page.getByTestId("checkout-line")).toHaveCount(1);
      await expect(page.getByTestId("checkout-line")).toContainText(`${product.name}`);
      await expect(page.getByTestId("checkout-line")).toContainText("1×");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Nomor WhatsApp").fill("0812 1111 2222");
      await fillAddress(page);
      await pickArea(page, "e2e jauh", /Kecamatan E2E Jauh/);
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await page.getByRole("button", { name: "Bayar sekarang" }).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      const order = await latestOrderFor(email);

      // The browser's back button from the payment page.
      await page.goBack();
      await expect(page).toHaveURL(/\/checkout$/);
      const banner = page.getByTestId("pending-order-banner");
      await expect(banner).toContainText(`Kamu punya pesanan ${order!.orderNo} yang menunggu pembayaran`);
      await expect(banner.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", /\/api\/test\/payments\//);
      await expect(banner.getByRole("button", { name: "Ganti metode pembayaran" })).toBeVisible();

      await page.goto("/cart");
      await expect(page.getByTestId("pending-order-banner")).toContainText(order!.orderNo);
      // The held last piece reads as sold out on its page; the reminder says why without a count.
      await page.goto(`/products/${product.slug}`);
      await expect(page.getByTestId("pending-order-banner")).toContainText(order!.orderNo);
      await expect(page.getByTestId("pending-order-banner")).not.toContainText(/\d+ (pcs|potong|stok)/);
      await page.goto(`/products/${other.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: other.name })).toBeVisible();
      await expect(page.getByTestId("pending-order-banner")).toHaveCount(0);

      // "Ganti metode pembayaran" from the reminder opens a new payment page for the same order.
      await page.goto("/cart");
      await page.getByTestId("pending-order-banner").getByRole("button", { name: "Ganti metode pembayaran" }).click();
      await expect(page).toHaveURL(new RegExp(`/api/test/payments/E2E-${order!.orderNo}-2$`));

      // Another browser sees no reminder anywhere.
      const stranger = await browser.newContext();
      const strangerPage = await stranger.newPage();
      for (const path of ["/cart", "/checkout", `/products/${product.slug}`]) {
        await strangerPage.goto(path);
        await expect(strangerPage.getByTestId("pending-order-banner")).toHaveCount(0);
      }
      expect(await (await strangerPage.request.get("/api/checkout/pending-order")).json()).toEqual({ order: null });
      await stranger.close();
    });

    test(`a logged-in buyer's last address comes back as a card with "Ganti alamat"; the quote is fresh (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const customer = await seedLinkCustomer(`alamat-${viewport.name.replace("px", "")}`);
      const product = await seedCheckoutProduct({ label: `Alamat ${viewport.name}` });
      await login(page, customer);

      await page.goto(`/products/${product.slug}`);
      await page.getByRole("button", { name: "M", exact: true }).click();
      await page.getByRole("button", { name: "Beli sekarang" }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      await waitForCheckoutForm(page);
      await expect(page.getByTestId("saved-address")).toHaveCount(0);
      await page.getByLabel("Nomor WhatsApp").fill("0812 7777 8888");
      await fillAddress(page, "Rina Wati");
      await pickArea(page, "e2e jauh", /Kecamatan E2E Jauh/);
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await page.getByRole("button", { name: "Bayar sekarang" }).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      await page.getByTestId("fake-payment-pay").click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran berhasil");

      // The next checkout: the address as a card, quoted again for its area.
      await page.goto(`/products/${product.slug}`);
      await page.getByRole("button", { name: "M", exact: true }).click();
      await page.getByRole("button", { name: "Beli sekarang" }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      await waitForCheckoutForm(page);
      const card = page.getByTestId("saved-address");
      await expect(card).toContainText("Rina Wati");
      await expect(card).toContainText("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
      await expect(card).toContainText(/Kecamatan E2E Jauh/);
      await expect(page.getByTestId("shipping-buyer-amount")).toHaveText("Rp75.000");
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");

      // "Ganti alamat": the normal form, prefilled; another area quotes again.
      await card.getByRole("button", { name: "Ganti alamat" }).click();
      await expect(page.getByLabel("Nama penerima")).toBeFocused();
      await expect(page.getByLabel("Nama penerima")).toHaveValue("Rina Wati");
      await page.getByRole("button", { name: /Ganti kecamatan/ }).click();
      await pickArea(page, "e2e murah", /Kecamatan E2E Murah/);
      await expect(page.getByTestId("summary-total")).toHaveText("Rp250.000");
      await page.getByRole("button", { name: "Pakai alamat tersimpan" }).click();
      await expect(page.getByTestId("saved-address")).toBeVisible();
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");
    });
  }
});
