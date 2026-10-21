import { randomInt } from "node:crypto";
import { expect, request as playwrightRequest, test, type BrowserContext } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { findSku, seedGuestCart } from "./helpers/cart-db";
import {
  customerContact,
  expireLoginLink,
  issueLoginLink,
  loginLinkState,
  seedGuestOrder,
  seedLinkCustomer,
  sessionCountFor,
  uniquePhone,
} from "./helpers/login-link-db";
import { E2E_PRODUCT_SLUG } from "./storefront-fixtures";

// "Masuk ke akun" one-time login links (docs/plans/cart-checkout.md §9.3, session 14). Opening the
// link only shows a confirm page; the login is its "Masuk" form POST. Runs with the cart flag off and
// on (the link does not depend on it; the cart merge check only runs with it on).
//
// Every test sends its own CF-Connecting-IP, so Better Auth's per-IP limit on the login POST (10 per
// 10 minutes, kept in ammari_e2e across runs) never carries over between tests or runs.

function randomIp(): string {
  return `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

async function ownIp(context: BrowserContext): Promise<string> {
  const ip = randomIp();
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
  return ip;
}

const linkUrl = (token: string) => `/login/link?token=${token}`;
// Only the main flow runs at both widths (this is not a list page; the other states share its layout).
const masked = (email: string) => `${email.slice(0, 1)}***${email.slice(email.indexOf("@"))}`;

for (const viewport of [
  { name: "390", size: { width: 390, height: 844 } },
  { name: "1280", size: { width: 1280, height: 800 } },
]) {
  test.describe(`at ${viewport.name}px`, () => {
    test.use({ viewport: viewport.size });

    test("opening the link does not log in; Masuk does, once", async ({ page, context }) => {
      await ownIp(context);
      const customer = await seedLinkCustomer("link-login");
      const token = await issueLoginLink(customer);

      const response = await page.goto(linkUrl(token));
      expect(response?.headers()["referrer-policy"]).toBe("same-origin");
      expect(response?.headers()["x-robots-tag"]).toContain("noindex");
      // Never cached (the dev server answers no-cache, a production build no-store).
      expect(response?.headers()["cache-control"]).toMatch(/no-(store|cache)/);
      expect(response?.headers()["x-frame-options"]).toBe("DENY");
      expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      await expect(page.getByRole("heading", { name: "Masuk ke akun" })).toBeVisible();
      await expect(page.getByText(`Masuk sebagai ${masked(customer.email)}`)).toBeVisible();
      // The full address never shows.
      await expect(page.getByText(customer.email)).toHaveCount(0);
      expect(await sessionCountFor(customer)).toBe(0);
      expect(await loginLinkState(token)).toEqual({ consumed: false, superseded: false });

      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page).toHaveURL(/\/orders$/);
      // The login lands on "Pesanan saya" (session 15).
      await expect(page.getByRole("heading", { name: "Pesanan saya" })).toBeVisible();
      expect(await sessionCountFor(customer)).toBe(1);
      expect(await loginLinkState(token)).toEqual({ consumed: true, superseded: false });
    });
  });
}

test("a link used twice: the second browser gets 'Link sudah tidak berlaku' and no session", async ({ page, context, browser, baseURL }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-twice");
  const token = await issueLoginLink(customer);
  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);

  const other = await browser.newContext();
  try {
    await ownIp(other);
    const second = await other.newPage();
    await second.goto(linkUrl(token));
    await expect(second.getByRole("heading", { name: "Link sudah tidak berlaku" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Masuk" })).toHaveCount(0);
    await expect(second.getByRole("link", { name: "Masuk dengan kode" })).toHaveAttribute("href", "/login?next=%2Forders");
    // A POST of the used token (e.g. a stale tab) lands on the same answer.
    const posted = await second.request.post("/api/auth/order-login-link/consume", { form: { token }, headers: { origin: new URL(baseURL!).origin }, maxRedirects: 0 });
    expect(posted.status()).toBe(302);
    expect(posted.headers()["location"]).toBe("/login/link?status=invalid");
  } finally {
    await other.close();
  }
  expect(await sessionCountFor(customer)).toBe(1);
});

test("an expired link does not log in", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-expired");
  const token = await issueLoginLink(customer);
  await expireLoginLink(token);
  await page.goto(linkUrl(token));
  await expect(page.getByRole("heading", { name: "Link sudah tidak berlaku" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Masuk" })).toHaveCount(0);
  expect(await sessionCountFor(customer)).toBe(0);
});

test("a second link revokes the first", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-second");
  const first = await issueLoginLink(customer);
  const second = await issueLoginLink(customer);
  expect(await loginLinkState(first)).toEqual({ consumed: false, superseded: true });

  await page.goto(linkUrl(first));
  await expect(page.getByRole("heading", { name: "Link sudah tidak berlaku" })).toBeVisible();
  await page.goto(linkUrl(second));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("an email scanner prefetching the link (GET) logs nobody in and leaves the link working", async ({ page, context, baseURL }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-scanner");
  const token = await issueLoginLink(customer);

  // A scanner: no cookies of the buyer, follows redirects, fetches the URL a few times.
  const scanner = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
  try {
    for (let i = 0; i < 3; i += 1) {
      const fetched = await scanner.get(linkUrl(token));
      expect(fetched.status()).toBe(200);
      expect(fetched.headers()["set-cookie"] ?? "").not.toContain("session_token");
    }
    // Even the login endpoint answers nothing to a GET.
    expect((await scanner.get(`/api/auth/order-login-link/consume?token=${token}`)).status()).toBe(404);
  } finally {
    await scanner.dispose();
  }
  expect(await sessionCountFor(customer)).toBe(0);
  expect(await loginLinkState(token)).toEqual({ consumed: false, superseded: false });

  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("CSRF: a POST from another site or without an Origin is refused and the link stays usable", async ({ page, context, baseURL }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-csrf");
  const token = await issueLoginLink(customer);

  const attacker = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
  try {
    const attempts: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      {},
    ];
    for (const headers of attempts) {
      const response = await attacker.post("/api/auth/order-login-link/consume", { form: { token }, headers, maxRedirects: 0 });
      expect(response.status()).toBe(303);
      expect(response.headers()["location"]).toBe("/login/link?status=blocked");
      expect(response.headers()["set-cookie"] ?? "").not.toContain("session_token");
    }
  } finally {
    await attacker.dispose();
  }
  expect(await sessionCountFor(customer)).toBe(0);
  expect(await loginLinkState(token)).toEqual({ consumed: false, superseded: false });

  // The refusal page explains, without logging in.
  await page.goto("/login/link?status=blocked");
  await expect(page.getByRole("heading", { name: "Permintaan tidak bisa diproses" })).toBeVisible();
  // The buyer's own click still works.
  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("without PDP consent the login lands on the consent step first", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-consent", { consented: false });
  const token = await issueLoginLink(customer);
  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/consent\?next=%2Forders$/);
});

test("after login, Pesanan saya offers the WhatsApp number and promo choice of the guest order; nothing is copied unasked", async ({ page, context }) => {
  await ownIp(context);
  const customer = await seedLinkCustomer("link-offer");
  const phone = uniquePhone();
  const orderNo = await seedGuestOrder(customer, { phone, promoOptIn: true });
  const token = await issueLoginLink(customer);
  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);

  await expect(page.getByRole("heading", { name: "Simpan data dari pesananmu?" })).toBeVisible();
  await expect(page.getByText(`memakai nomor WhatsApp ${phone}`, { exact: false })).toBeVisible();
  await expect(page.getByText(`Pesanan ${orderNo}`, { exact: false })).toBeVisible();
  const promo = page.getByRole("checkbox", { name: "Kirimi saya kabar koleksi baru dan promo dari Ammari." });
  await expect(promo).not.toBeChecked();
  expect(await customerContact(customer)).toEqual({ phone: null, promo: false });

  await promo.check();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan di akunmu.");
  await expect(page.getByRole("heading", { name: "Simpan data dari pesananmu?" })).toHaveCount(0);
  expect(await customerContact(customer)).toEqual({ phone, promo: true });
});

test("the guest cart merges into the account after a login by link", async ({ page, context, baseURL }) => {
  test.skip(!CART_E2E, "cart flag off");
  await ownIp(context);
  const customer = await seedLinkCustomer("link-cart");
  const sku = await findSku(E2E_PRODUCT_SLUG, "Beige E2E", "M");
  await seedGuestCart(context, baseURL!, [{ sku, qty: 2 }]);
  const token = await issueLoginLink(customer);
  await page.goto(linkUrl(token));
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);

  await page.goto("/cart");
  await expect(page.getByText("2 barang")).toBeVisible();
  // The guest cookie named a guest cart; the lines now belong to the customer's cart.
  await context.clearCookies({ name: "ammari_cart" });
  await page.reload();
  await expect(page.getByText("2 barang")).toBeVisible();
});
