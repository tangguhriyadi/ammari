import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withTriggerDisabled } from "@ammari/db/test-utils";
import { insertCustomer, insertProductVariant } from "@ammari/db/test-fixtures";
import {
  auditLog,
  cartItems,
  carts,
  claimRateLimits,
  customers,
  fabricColors,
  fabrics,
  orderAccessTokens,
  orders,
  payments,
  products,
  productVariants,
  stockMovements,
  stockReservations,
} from "@ammari/db/schema";
import { generateCartToken, hashCartToken } from "@ammari/commerce/cart";
import { hashOrderAccessToken } from "@ammari/commerce/checkout";
import { createFakeShippingRateProvider, searchShippingAreas } from "@ammari/commerce/shipping";

// docs/plans/cart-checkout.md §5, session 9: placeOrderAction around @ammari/commerce's
// placeOrder, against the real `ammari_test` database (committed writes, cleaned up below), with
// the fake shipping and payment providers, an in-memory cookie jar, a fixed client IP and spies
// for Next's cache API. Nothing here reaches a provider.

interface SetCookie {
  value: string;
  options: Record<string, unknown>;
}

const jar = new Map<string, string>();
const setCookies = new Map<string, SetCookie>();
const deletedCookies = new Set<string>();
let clientIp = "203.0.113.20";
let session: { id: string; email: string | null } | null = null;
let placeOrderThrows = false;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, value);
      setCookies.set(name, { value, options });
    },
    delete: (name: string) => {
      jar.delete(name);
      deletedCookies.add(name);
    },
  }),
  headers: async () => new Headers({ "cf-connecting-ip": clientIp }),
}));
const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath, revalidateTag, unstable_cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/auth/customer-session", () => ({
  getCustomerSession: async () =>
    session ? { ...session, name: "Pelanggan", phone: null, pdpConsentAt: new Date(), promoConsentAt: null } : null,
}));
vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));
// The `created` email is scheduled after the response (lib/emails/order-emails.ts, tested there).
const scheduleOrderEmails = vi.fn();
vi.mock("@/lib/emails/order-emails", () => ({ scheduleOrderEmails }));
vi.mock("@ammari/commerce/checkout", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ammari/commerce/checkout")>();
  return {
    ...original,
    placeOrder: (...args: Parameters<typeof original.placeOrder>) => {
      if (placeOrderThrows) throw new Error("connection terminated");
      return original.placeOrder(...args);
    },
  };
});

const { placeOrderAction } = await import("./actions");
const { CHECKOUT_SUBMIT_LIMIT } = await import("./messages");

const PRICE = 259_000;
const created = { skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[], emails: [] as string[], customerIds: [] as string[] };
const usedIps = new Set<string>();
let murahAreaId = "";
let jauhAreaId = "";

async function sellableSku(): Promise<{ sku: string; slug: string }> {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  await testDb.update(products).set({ isPublishedOnStorefront: true, shippingWeightGrams: 700 }).where(eq(products.id, product.id));
  await testDb.insert(stockMovements).values({ sku: variant.sku, qty: 5, valueAmount: 500_000, type: "production", refType: "manual" });
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  return { sku: variant.sku, slug: product.slug };
}

/** A guest cart with one line, its token in the cookie jar. */
async function guestCartWith(sku: string): Promise<string> {
  const token = generateCartToken();
  const [cart] = await testDb.insert(carts).values({ tokenHash: hashCartToken(token) }).returning();
  await testDb.insert(cartItems).values({ cartId: cart!.id, sku, qty: 1 });
  jar.set("ammari_cart", token);
  return token;
}

function input(overrides: Record<string, unknown> = {}) {
  const email = `checkout-${randomUUID()}@example.test`;
  created.emails.push(email);
  return {
    checkoutAttemptId: randomUUID(),
    contact: { email, phone: "0812 1111 2222" },
    address: { recipientName: "Siti Aminah", phone: "0812 3456 7890", addressLine: "Jl. Melati No. 5, Kel. Sukamaju" },
    shippingAreaId: murahAreaId,
    voucherId: null,
    termsAccepted: true,
    promoOptIn: false,
    expectedTotal: PRICE,
    ...overrides,
  };
}

const ENV = {
  STOREFRONT_CART_ENABLED: "true",
  SHIPPING_RATE_PROVIDER: "fake",
  PAYMENT_PROVIDER: "fake",
  E2E_TEST_LOGIN: "true",
  BETTER_AUTH_URL: "http://localhost:3000",
};

beforeAll(async () => {
  const fake = createFakeShippingRateProvider();
  murahAreaId = (await searchShippingAreas(testDb, fake, "Murah"))[0]!.id;
  jauhAreaId = (await searchShippingAreas(testDb, fake, "Jauh"))[0]!.id;
});

beforeEach(async () => {
  jar.clear();
  setCookies.clear();
  deletedCookies.clear();
  session = null;
  placeOrderThrows = false;
  revalidatePath.mockClear();
  revalidateTag.mockClear();
  scheduleOrderEmails.mockClear();
  Object.assign(process.env, ENV);
  clientIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  usedIps.add(clientIp);
  await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
});

afterAll(async () => {
  const orderIds = (await testDb.select({ id: orders.id }).from(orders).where(inArray(orders.contactEmail, created.emails))).map((row) => row.id);
  if (orderIds.length > 0) {
    await testDb.delete(stockReservations).where(inArray(stockReservations.orderId, orderIds));
    await testDb.delete(payments).where(inArray(payments.orderId, orderIds));
    await testDb.delete(orderAccessTokens).where(inArray(orderAccessTokens.orderId, orderIds));
    await testDb.delete(auditLog).where(inArray(auditLog.entityId, orderIds));
    await testDb.delete(orders).where(inArray(orders.id, orderIds));
  }
  await testDb.delete(cartItems).where(inArray(cartItems.sku, created.skus));
  const customerIds = [
    ...created.customerIds,
    ...(await testDb.select({ id: customers.id }).from(customers).where(inArray(customers.email, created.emails))).map((row) => row.id),
  ];
  if (customerIds.length > 0) {
    await testDb.delete(carts).where(inArray(carts.customerId, customerIds));
    await testDb.delete(customers).where(inArray(customers.id, customerIds));
  }
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
    testDb.delete(stockMovements).where(inArray(stockMovements.sku, created.skus)),
  );
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
  await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...usedIps]));
});

async function orderFor(attemptId: string) {
  return (await testDb.select().from(orders).where(eq(orders.checkoutAttemptId, attemptId)))[0];
}

describe("placeOrderAction", () => {
  test("flag off: refused without touching the database or cookies", async () => {
    delete process.env.STOREFRONT_CART_ENABLED;
    const result = await placeOrderAction(input());
    expect(result).toEqual({ ok: false, message: "Checkout belum tersedia.", fieldErrors: [] });
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp))).toHaveLength(0);
    expect(setCookies.size).toBe(0);
  });

  test("a guest checkout: order placed, payment page returned, finish-page cookie set, product page revalidated", async () => {
    const { sku, slug } = await sellableSku();
    await guestCartWith(sku);
    const body = input();
    const result = await placeOrderAction(body);
    if (!result.ok) throw new Error(result.message);
    expect(result.redirectUrl).toBe(`http://localhost:3000/api/test/payments/${result.orderNo}-1`);

    const order = await orderFor(body.checkoutAttemptId);
    expect(order).toMatchObject({ orderNo: result.orderNo, status: "awaiting_payment", placedWithSession: false, shippingCostAmount: 12_000, shippingAmount: 0 });

    const cookie = setCookies.get("ammari_checkout_order_v2");
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const [token] = await testDb.select().from(orderAccessTokens).where(eq(orderAccessTokens.orderId, order!.id));
    expect(token?.tokenHash).toBe(hashOrderAccessToken(cookie!.value));

    expect(revalidatePath).toHaveBeenCalledWith(`/products/${slug}`);
    expect(revalidateTag).toHaveBeenCalledWith(`storefront:product:${slug}`, { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith("storefront:products", "max");
    expect(revalidateTag).toHaveBeenCalledWith("storefront:homepage", "max");
    // The guest's cart cookie stays (the cart row is kept, now empty).
    expect(deletedCookies.has("ammari_cart")).toBe(false);
    expect(scheduleOrderEmails).toHaveBeenCalledWith([{ orderId: order!.id }], "checkout");
  });

  test("a refusal returns placeOrder's message and field errors; nothing is created or revalidated", async () => {
    const { sku } = await sellableSku();
    await guestCartWith(sku);
    const body = input({ termsAccepted: false, contact: { phone: "12" } });
    const result = await placeOrderAction(body);
    expect(result).toMatchObject({ ok: false, message: "Periksa lagi data yang ditandai." });
    if (result.ok) return;
    expect(result.fieldErrors.map((error) => error.field)).toEqual(["contactEmail", "contactPhone", "termsAccepted"]);
    expect(await orderFor(body.checkoutAttemptId)).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(setCookies.has("ammari_checkout_order_v2")).toBe(false);
    expect(scheduleOrderEmails).not.toHaveBeenCalled();
  });

  test("the buyer's ongkir share is part of the total the action checks", async () => {
    const { sku } = await sellableSku();
    await guestCartWith(sku);
    expect(await placeOrderAction(input({ shippingAreaId: jauhAreaId }))).toMatchObject({
      ok: false,
      message: "Harga, ongkir atau voucher berubah. Cek ringkasan lagi.",
    });
    const body = input({ shippingAreaId: jauhAreaId, expectedTotal: PRICE + 75_000 });
    expect(await placeOrderAction(body)).toMatchObject({ ok: true });
    expect(await orderFor(body.checkoutAttemptId)).toMatchObject({ shippingAmount: 75_000, totalAmount: PRICE + 75_000 });
  });

  test("a logged-in buyer: the session's email is the contact, and a leftover guest cookie is cleared", async () => {
    const { sku } = await sellableSku();
    const customer = await insertCustomer(testDb);
    created.customerIds.push(customer.id);
    created.emails.push(customer.email!);
    await guestCartWith(sku);
    session = { id: customer.id, email: customer.email };
    const body = input();
    const result = await placeOrderAction(body);
    if (!result.ok) throw new Error(result.message);
    expect(await orderFor(body.checkoutAttemptId)).toMatchObject({ customerId: customer.id, contactEmail: customer.email, placedWithSession: true });
    expect(deletedCookies.has("ammari_cart")).toBe(true);
  });

  test(`at most ${CHECKOUT_SUBMIT_LIMIT} submits per IP in 10 minutes`, async () => {
    await testDb.insert(claimRateLimits).values(Array.from({ length: CHECKOUT_SUBMIT_LIMIT }, () => ({ ip: clientIp, action: "checkout_submit" })));
    expect(await placeOrderAction(input())).toEqual({ ok: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.", fieldErrors: [] });
  });

  test("a malformed payload or a form with mistakes never counts against the submit limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await placeOrderAction({ ...input(), checkoutAttemptId: "not-a-uuid" })).toMatchObject({
      ok: false,
      message: "Permintaan tidak valid. Muat ulang halaman lalu coba lagi.",
    });
    // Field paths only, never values.
    expect(warn).toHaveBeenCalledWith("[checkout] malformed checkout payload", { paths: ["checkoutAttemptId"] });
    warn.mockRestore();
    expect(await placeOrderAction(input({ termsAccepted: false }))).toMatchObject({ ok: false, message: "Periksa lagi data yang ditandai." });
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp))).toHaveLength(0);
  });

  test("a logged-in buyer whose form is refused before the cart merge keeps the guest cookie", async () => {
    const { sku } = await sellableSku();
    const customer = await insertCustomer(testDb);
    created.customerIds.push(customer.id);
    await guestCartWith(sku);
    session = { id: customer.id, email: customer.email };
    expect(await placeOrderAction(input({ termsAccepted: false }))).toMatchObject({ ok: false });
    expect(deletedCookies.has("ammari_cart")).toBe(false);
  });

  test("a guest's repeat submit gets the payment page back only with the checkout cookie", async () => {
    const { sku } = await sellableSku();
    await guestCartWith(sku);
    const body = input();
    const first = await placeOrderAction(body);
    if (!first.ok) throw new Error(first.message);
    // The browser sends the cookie back on the checkout page (path /checkout).
    expect(await placeOrderAction(body)).toEqual(first);
    jar.delete("ammari_checkout_order_v2");
    expect(await placeOrderAction(body)).toEqual({ ...first, redirectUrl: null });
  });

  test("an unconfigured shipping or payment provider fails closed before anything is written", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sku } = await sellableSku();
    await guestCartWith(sku);

    delete process.env.SHIPPING_RATE_PROVIDER;
    const first = input();
    expect(await placeOrderAction(first)).toMatchObject({ ok: false, message: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi." });
    expect(await orderFor(first.checkoutAttemptId)).toBeUndefined();

    process.env.SHIPPING_RATE_PROVIDER = "fake";
    delete process.env.PAYMENT_PROVIDER;
    // Midtrans (the default) without its key, whatever a developer's .env holds.
    vi.stubEnv("MIDTRANS_SERVER_KEY", "");
    const second = input();
    expect(await placeOrderAction(second)).toMatchObject({ ok: false, message: "Pembayaran belum bisa diproses. Coba lagi sebentar lagi." });
    expect(await orderFor(second.checkoutAttemptId)).toBeUndefined();
    // Variable names only in the log.
    expect(JSON.stringify(errors.mock.calls)).toContain("MIDTRANS_SERVER_KEY is not set");
    vi.unstubAllEnvs();
    errors.mockRestore();
  });

  test("an unexpected failure is logged and answered with the generic retry message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    placeOrderThrows = true;
    expect(await placeOrderAction(input())).toEqual({ ok: false, message: "Terjadi kesalahan. Coba lagi.", fieldErrors: [] });
    // Name and Postgres code only, never the message (a failed query's text carries its parameters).
    expect(errors).toHaveBeenCalledWith("[checkout] place order failed", expect.objectContaining({ error: "Error" }));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("connection terminated");
    errors.mockRestore();
  });
});
