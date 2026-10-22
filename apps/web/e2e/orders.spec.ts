import { randomInt } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { seedCheckoutProduct, sellOut } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer, type LinkCustomer } from "./helpers/login-link-db";
import { customerCartLines, e2eOrderNo, issueViewToken, seedCheckoutOrder, seedMarketplaceOrder } from "./helpers/orders-db";

// "Pesanan saya" and "Lihat pesanan" (docs/plans/cart-checkout.md §9.1, §9.2, session 15). Runs
// with the cart flag off and on: the order pages work either way (plan §14, owner decision
// 2026-10-21); "Pesan lagi" and the /account preview need the flag. List pages are checked at
// 390 px and 1280 px.
//
// Every test sends its own CF-Connecting-IP, so the per-IP limits (`order_view`, the login POST's)
// never carry over between tests or runs.

const NOT_FOUND = "Pesanan tidak bisa ditampilkan";

function randomIp(): string {
  return `198.19.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": randomIp() });
}

/** Logs the customer in through a login link; it lands on "Pesanan saya". */
async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

async function freshContext(browser: Browser, viewport = { width: 390, height: 844 }): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  await ownIp(context);
  return context;
}

for (const viewport of [
  { name: "390", size: { width: 390, height: 844 } },
  { name: "1280", size: { width: 1280, height: 800 } },
]) {
  test.describe(`at ${viewport.name}px`, () => {
    test.use({ viewport: viewport.size });

    test("Pesanan saya lists the customer's own orders with status and total; the detail page shows lines, ongkir and tracking", async ({ page, context }) => {
      await ownIp(context);
      const customer = await seedLinkCustomer(`orders-list-${viewport.name}`);
      const product = await seedCheckoutProduct({ label: `Pesanan ${viewport.name}`, price: 250_000 });
      const shipped = await seedCheckoutOrder({ customerId: customer.id, email: customer.email, placedWithSession: true, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "shipped" });
      const marketplace = await seedMarketplaceOrder(customer.id, { sku: product.sku, qty: 2, unitPrice: 199_000 });
      // A guest order typed with this account's email shows; one typed with another email does not.
      const guest = await seedCheckoutOrder({ customerId: customer.id, email: customer.email, placedWithSession: false, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "cancelled" });
      const strangerEmail = await seedCheckoutOrder({ customerId: customer.id, email: `other-${customer.email}`, placedWithSession: false, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "pending" });

      await login(page, customer);
      const response = await page.reload();
      expect(response?.headers()["referrer-policy"]).toBe("same-origin");
      expect(response?.headers()["x-frame-options"]).toBe("DENY");
      expect(response?.headers()["x-robots-tag"]).toContain("noindex");
      // A stray `?t=` on the list never drops its framing protection.
      const withQuery = await page.request.get("/orders?t=x", { maxRedirects: 0 });
      expect(withQuery.headers()["x-frame-options"]).toBe("DENY");

      const list = page.getByTestId("order-list");
      await expect(list.getByRole("link")).toHaveCount(3);
      await expect(list.getByRole("link", { name: new RegExp(shipped.orderNo) })).toContainText("Dikirim");
      await expect(list.getByRole("link", { name: new RegExp(shipped.orderNo) })).toContainText("Rp325.000");
      await expect(list.getByRole("link", { name: new RegExp(guest.orderNo) })).toContainText("Dibatalkan");
      await expect(list.getByRole("link", { name: new RegExp(marketplace.orderNo) })).toContainText("Diproses");
      await expect(list.getByRole("link", { name: new RegExp(marketplace.orderNo) })).toContainText("Shopee");
      await expect(page.getByText(strangerEmail.orderNo)).toHaveCount(0);
      // Rows never overflow the phone width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      await list.getByRole("link", { name: new RegExp(shipped.orderNo) }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${shipped.orderNo}$`));
      await expect(page.getByTestId("order-status")).toHaveText("Dikirim");
      await expect(page.getByTestId("order-courier-cost")).toHaveText("Rp95.000");
      await expect(page.getByTestId("order-subsidy")).toHaveText("-Rp20.000");
      await expect(page.getByTestId("order-shipping")).toHaveText("Rp75.000");
      await expect(page.getByTestId("order-total")).toHaveText("Rp325.000");
      await expect(page.getByTestId("order-tracking")).toContainText("JNE0001E2E");
      await expect(page.getByText("Jl. Melati 2", { exact: false })).toBeVisible();
      // No cost data anywhere on the page (the ongkir quote is the buyer's own figure and is shown).
      await expect(page.getByText("111.111", { exact: false })).toHaveCount(0);

      // The order typed with another email is not this account's to see.
      await page.goto(`/orders/${strangerEmail.orderNo}`);
      await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);

      // /account: with the cart flag on, the newest orders and "Lihat semua pesanan"; off, as before.
      await page.goto("/account");
      await expect(page.getByRole("link", { name: "Lihat semua pesanan" })).toHaveCount(CART_E2E ? 1 : 0);
      await expect(page.getByText(shipped.orderNo)).toBeVisible();
    });
  });
}

test("the Lihat pesanan link on another device: the token becomes a cookie for that order only and leaves the URL", async ({ browser }) => {
  const product = await seedCheckoutProduct({ label: "Link Pesanan", price: 250_000 });
  const owner = await seedLinkCustomer("orders-link");
  const order = await seedCheckoutOrder({
    customerId: owner.id,
    email: owner.email,
    placedWithSession: false,
    lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }],
    state: "pending",
    paymentUrl: "https://app.sandbox.example/snap/v4/redirection/e2e",
  });
  const other = await seedCheckoutOrder({ customerId: owner.id, email: owner.email, placedWithSession: false, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "pending" });
  const token = await issueViewToken(order.id);

  const phone = await freshContext(browser);
  try {
    const page = await phone.newPage();
    // The hop that carries the token: a bodyless 303 with no Referer policy, nothing rendered.
    const hop = await page.request.get(`/orders/${order.orderNo}?t=${token}`, { maxRedirects: 0 });
    expect(hop.status()).toBe(303);
    expect(hop.headers()["referrer-policy"]).toBe("no-referrer");
    expect(hop.headers()["location"]).toBe(`/orders/${order.orderNo}`);
    expect(hop.headers()["set-cookie"]).toContain(`Path=/orders/${order.orderNo}`);
    expect(hop.headers()["set-cookie"]).toContain("HttpOnly");
    await phone.clearCookies();

    await page.goto(`/orders/${order.orderNo}?t=${token}`);
    await expect(page).toHaveURL(new RegExp(`/orders/${order.orderNo}$`));
    await expect(page.getByTestId("order-status")).toHaveText("Menunggu pembayaran");
    await expect(page.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", "https://app.sandbox.example/snap/v4/redirection/e2e");
    // View only: no link to the account's order list.
    await expect(page.getByRole("link", { name: "Pesanan saya" })).toHaveCount(0);
    const cookies = await phone.cookies();
    expect(cookies.find((cookie) => cookie.name === `ammari_order_view_${order.orderNo}`)).toMatchObject({ path: `/orders/${order.orderNo}`, httpOnly: true, sameSite: "Lax" });
    // The site-wide list logout uses to clear it (lib/orders/view-cookie.ts).
    expect(cookies.find((cookie) => cookie.name === "ammari_order_views")).toMatchObject({ value: order.orderNo, path: "/", httpOnly: true, sameSite: "Lax" });

    // A reload works from the cookie alone; history holds only the clean URL.
    await page.reload();
    await expect(page.getByTestId("order-status")).toHaveText("Menunggu pembayaran");
    expect(await page.evaluate(() => window.location.search)).toBe("");

    // The cookie opens that order only.
    await page.goto(`/orders/${other.orderNo}`);
    await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/login\?next=%2Forders$/);
  } finally {
    await phone.close();
  }

  // A third device without the link sees nothing.
  const stranger = await freshContext(browser);
  try {
    const page = await stranger.newPage();
    await page.goto(`/orders/${order.orderNo}`);
    await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);
    await expect(page.getByText("Rp325.000")).toHaveCount(0);
  } finally {
    await stranger.close();
  }
});

test("an expired token, a wrong token and an unknown order number all read the same, and set no cookie", async ({ browser }) => {
  const product = await seedCheckoutProduct({ label: "Token Salah", price: 250_000 });
  const owner = await seedLinkCustomer("orders-bad-token");
  const order = await seedCheckoutOrder({ customerId: owner.id, email: owner.email, placedWithSession: false, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "pending" });
  const expired = await issueViewToken(order.id, { expired: true });
  const valid = await issueViewToken(order.id);

  const context = await freshContext(browser, { width: 1280, height: 800 });
  try {
    const page = await context.newPage();
    for (const url of [
      `/orders/${order.orderNo}?t=${expired}`,
      `/orders/${order.orderNo}?t=${valid.slice(0, -2)}xy`,
      `/orders/${e2eOrderNo()}?t=${valid}`,
      `/orders/${order.orderNo}`,
    ]) {
      await page.goto(url);
      await expect(page).not.toHaveURL(/[?&]t=/);
      await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);
      await expect(page.getByRole("link", { name: "Masuk untuk melihat pesanan" })).toHaveAttribute("href", "/login?next=%2Forders");
    }
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith("ammari_order_view"))).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("another customer's order is not found for a logged-in customer, even by number", async ({ page, context }) => {
  await ownIp(context);
  const product = await seedCheckoutProduct({ label: "Orang Lain", price: 250_000 });
  const owner = await seedLinkCustomer("orders-owner");
  const intruder = await seedLinkCustomer("orders-intruder");
  const order = await seedCheckoutOrder({ customerId: owner.id, email: owner.email, placedWithSession: true, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "shipped" });

  await login(page, intruder);
  await expect(page.getByText("Belum ada pesanan.")).toBeVisible();
  const response = await page.goto(`/orders/${order.orderNo}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId("order-not-found")).toHaveText(NOT_FOUND);
  await expect(page.getByText("JNE0001E2E")).toHaveCount(0);
});

test("Pesan lagi with a sold-out item: the rest goes into the cart, the sold-out line is named, the header count updates", async ({ page, context }) => {
  await ownIp(context);
  const available = await seedCheckoutProduct({ label: "Pesan Lagi Ada", price: 250_000, stock: 10 });
  const soldOut = await seedCheckoutProduct({ label: "Pesan Lagi Habis", price: 260_000, stock: 2 });
  await sellOut(soldOut.sku);
  const customer = await seedLinkCustomer("orders-reorder");
  const order = await seedCheckoutOrder({
    customerId: customer.id,
    email: customer.email,
    placedWithSession: true,
    lines: [
      { sku: available.sku, qty: 2, unitPrice: 250_000 },
      { sku: soldOut.sku, qty: 1, unitPrice: 260_000 },
    ],
    state: "cancelled",
  });

  await login(page, customer);
  await page.goto(`/orders/${order.orderNo}`);
  await expect(page.getByTestId("order-status")).toHaveText("Dibatalkan");

  if (!CART_E2E) {
    // Flag off: the page still works, nothing can be put in a cart.
    await expect(page.getByRole("button", { name: "Pesan lagi" })).toHaveCount(0);
    return;
  }

  await page.getByRole("button", { name: "Pesan lagi" }).click();
  const result = page.getByTestId("reorder-result");
  await expect(result).toContainText("Sebagian barang sudah masuk keranjang.");
  await expect(result).toContainText(`${soldOut.name} (Krem Checkout E2E · M): Habis`);
  await expect(page.getByRole("link", { name: "Keranjang, 2 barang" })).toBeVisible();
  expect(await customerCartLines(customer.id)).toEqual({ [available.sku]: 2 });

  await result.getByRole("link", { name: "Lihat keranjang" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText("2 barang")).toBeVisible();
  await expect(page.getByText(soldOut.name)).toHaveCount(0);
});
