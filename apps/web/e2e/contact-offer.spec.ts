import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { seedGuestCart } from "./helpers/cart-db";
import { clearCheckoutRateLimits, seedCheckoutProduct } from "./helpers/checkout-db";
import { takeOtp } from "./helpers/otp";

// 2026-10-22 dev feedback: a buyer paid a guest checkout order, later logged in by email OTP with
// the same email, and the next checkout prefilled only the name (a guest order never saves an
// address). The /account offer now also carries the order's shipping address; "Simpan" makes it the
// default address, so the next checkout opens on the saved-address card. Nothing reaches a real
// provider: the fake shipping and payment providers come from playwright.config.ts.

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

const OFFER_HEADING = "Pakai data ini untuk belanja berikutnya?";
const ADDRESS_LINE = "Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju";
const AREA_LABEL = /Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111/;

/** Its own CF-Connecting-IP per test, so Better Auth's per-IP limit on the login POST (kept in
 * ammari_e2e across runs) never carries over (same as login-link.spec.ts). */
async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

function uniqueEmail(label: string, testInfo: { project: { name: string } }): string {
  return `${label}-${testInfo.project.name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.ammari.test`;
}

/** A paid guest checkout for `email` (the fake gateway pays through the real notification route). */
async function paidGuestOrder(page: Page, context: BrowserContext, baseURL: string, email: string, label: string) {
  const product = await seedCheckoutProduct({ label });
  await seedGuestCart(context, baseURL, [{ sku: product.sku, qty: 1 }]);
  await page.goto("/checkout");
  await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Nomor WhatsApp").fill("0812 1111 2222");
  await page.getByLabel("Nama penerima").fill("Siti Aminah");
  await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
  await page.getByLabel("Alamat lengkap").fill(ADDRESS_LINE);
  await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill("40111");
  await page.getByRole("option", { name: AREA_LABEL }).click();
  await expect(page.getByTestId("summary-total")).toHaveText("Rp250.000");
  await page.getByLabel(/Saya setuju dengan/).check();
  await page.getByRole("button", { name: "Bayar sekarang" }).click();
  await expect(page).toHaveURL(/\/api\/test\/payments\//);
  await page.getByTestId("fake-payment-pay").click();
  await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran berhasil");
  return product;
}

/** The offer card, before and after it is answered. */
function offerCard(page: Page) {
  return page.getByTestId("contact-offer");
}

/** An email OTP login from /login, through the PDP consent step a guest-created account has not
 * passed yet, landing on /account. */
async function otpLogin(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Kirim kode" }).click();
  await expect(page.getByLabel("Kode (6 digit)")).toBeVisible();
  await page.getByLabel("Kode (6 digit)").fill(await takeOtp(page, email));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/consent/);
  await page.getByRole("checkbox", { name: /Dengan melanjutkan/ }).check();
  await page.getByRole("button", { name: "Lanjutkan" }).click();
  await expect(page).toHaveURL(/\/account$/);
}

test.describe("the /account offer keeps the guest order's address", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async ({ context }) => {
    await clearCheckoutRateLimits();
    await ownIp(context);
  });

  for (const viewport of VIEWPORTS) {
    test(`guest order, OTP login, Simpan: the next checkout opens on the saved address and quotes it (${viewport.name})`, async ({ page, context, baseURL }, testInfo) => {
      await page.setViewportSize(viewport);
      const email = uniqueEmail("offer-save", testInfo);
      await paidGuestOrder(page, context, baseURL!, email, `Tawar ${viewport.name}`);
      // Something in the cart for the next checkout; it merges into the account at the login.
      const next = await seedCheckoutProduct({ label: `Tawar Lagi ${viewport.name}` });
      await seedGuestCart(context, baseURL!, [{ sku: next.sku, qty: 1 }]);

      await otpLogin(page, email);
      await expect(page.getByRole("heading", { name: OFFER_HEADING })).toBeVisible();
      const card = offerCard(page);
      await expect(card.getByText(/^Pesanan ORD-/)).toBeVisible();
      const shown = page.getByTestId("contact-offer-address");
      await expect(shown).toContainText("Siti Aminah");
      await expect(shown).toContainText("+6281234567890");
      await expect(shown).toContainText(ADDRESS_LINE);
      await expect(shown).toContainText(AREA_LABEL);
      // Read-only: nothing in it can be typed into.
      await expect(shown.getByRole("textbox")).toHaveCount(0);
      // Never ticked by default (owner decision 2026-10-22): the buyer ticks it.
      const keep = card.getByRole("checkbox", { name: "Simpan alamat ini untuk checkout berikutnya." });
      await expect(keep).not.toBeChecked();
      await keep.check();

      await card.getByRole("button", { name: "Simpan" }).click();
      await expect(card.getByRole("status")).toHaveText("Tersimpan di akunmu.");
      await page.reload();
      await expect(page.getByRole("heading", { name: OFFER_HEADING })).toHaveCount(0);

      await page.goto("/checkout");
      await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
      const saved = page.getByTestId("saved-address");
      await expect(saved).toContainText("Siti Aminah");
      await expect(saved).toContainText(ADDRESS_LINE);
      await expect(saved).toContainText(AREA_LABEL);
      await expect(saved.getByRole("button", { name: "Ganti alamat" })).toBeVisible();
      // The quote is computed again for the saved area (Murah: courier Rp12.000, buyer Rp0).
      await expect(page.getByTestId("shipping-courier-cost")).toHaveText("Rp12.000");
      await expect(page.getByTestId("summary-shipping")).toHaveText("Rp0");
      await expect(page.getByTestId("summary-total")).toHaveText("Rp250.000");
    });
  }

  test("Simpan with the address box unticked saves no address: the next checkout asks for it again", async ({ page, context, baseURL }, testInfo) => {
    const email = uniqueEmail("offer-unticked", testInfo);
    await paidGuestOrder(page, context, baseURL!, email, "Tanpa Centang");
    const next = await seedCheckoutProduct({ label: "Tanpa Centang Lagi" });
    await seedGuestCart(context, baseURL!, [{ sku: next.sku, qty: 1 }]);

    await otpLogin(page, email);
    const card = offerCard(page);
    await expect(card.getByRole("checkbox", { name: "Simpan alamat ini untuk checkout berikutnya." })).not.toBeChecked();
    await card.getByRole("button", { name: "Simpan" }).click();
    await expect(card.getByRole("status")).toHaveText("Tersimpan di akunmu.");

    await page.goto("/checkout");
    await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
    await expect(page.getByTestId("saved-address")).toHaveCount(0);
    await expect(page.getByLabel("Alamat lengkap")).toHaveValue("");
    await expect(page.getByTestId("shipping-row")).toHaveText("Pilih alamat dulu untuk menghitung ongkir.");
  });

  test("Lewati saves nothing: the next checkout asks for the address again", async ({ page, context, baseURL }, testInfo) => {
    const email = uniqueEmail("offer-skip", testInfo);
    await paidGuestOrder(page, context, baseURL!, email, "Lewati");
    const next = await seedCheckoutProduct({ label: "Lewati Lagi" });
    await seedGuestCart(context, baseURL!, [{ sku: next.sku, qty: 1 }]);

    await otpLogin(page, email);
    await expect(page.getByRole("heading", { name: OFFER_HEADING })).toBeVisible();
    const card = offerCard(page);
    await card.getByRole("button", { name: "Lewati" }).click();
    await expect(card.getByRole("status")).toHaveText("Baik, data pesanan tidak disimpan ke akun.");

    await page.goto("/checkout");
    await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
    await expect(page.getByTestId("saved-address")).toHaveCount(0);
    await expect(page.getByLabel("Alamat lengkap")).toHaveValue("");
    await expect(page.getByTestId("shipping-row")).toHaveText("Pilih alamat dulu untuk menghitung ongkir.");
  });

  test("a guest order typed with a different email is never offered", async ({ page, context, baseURL }, testInfo) => {
    await paidGuestOrder(page, context, baseURL!, uniqueEmail("offer-stranger", testInfo), "Orang Lain");
    await context.clearCookies();

    await otpLogin(page, uniqueEmail("offer-own", testInfo));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: OFFER_HEADING })).toHaveCount(0);
    await expect(page.getByTestId("contact-offer-address")).toHaveCount(0);
    await expect(page.getByText(ADDRESS_LINE)).toHaveCount(0);
  });
});
