import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { testDb, withTriggerDisabled } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant } from "@ammari/db/test-fixtures";
import { cartItems, carts, claimRateLimits, customers, fabricColors, fabrics, orderAccessTokens, orderItems, orders, products, productVariants, stockMovements } from "@ammari/db/schema";
import { generateOrderAccessToken, hashOrderAccessToken } from "@ammari/commerce/checkout";
import { hashCartToken } from "@ammari/commerce/cart";

// docs/plans/cart-checkout.md §9.1, §9.2, session 15: the "Lihat pesanan" token route (token to
// cookie, clean redirect, one answer for every refusal) and "Pesan lagi" (who may, what lands in
// the cart), against the real `ammari_test` database with Next's request APIs replaced by an
// in-memory cookie jar and a fixed client IP. The jar holds what the browser would send to the
// page posting the action (the order cookie is path-scoped to that order's page).

const jar = new Map<string, string>();
const issuedCartTokens = new Set<string>();
let clientIp = "203.0.113.20";
let sessionCustomerId: string | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => {
      jar.set(name, value);
      if (name === "ammari_cart") issuedCartTokens.add(value);
    },
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers(clientIp ? { "cf-connecting-ip": clientIp } : {}),
}));
vi.mock("@/lib/auth/customer-session", () => ({
  getCustomerSession: async () => (sessionCustomerId ? { id: sessionCustomerId, pdpConsentAt: new Date() } : null),
}));
vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));

const { reorderAction } = await import("./reorder-actions");
const { GET } = await import("@/app/api/orders/[orderNo]/view/route");
const { ORDER_VIEW_LIMIT } = await import("./limits");
const { changePaymentMethodAction, reopenPaymentPageAction } = await import("@/lib/checkout/payment-actions");
const { PAYMENT_CHANGE_LIMIT, PAYMENT_RETRY_CLOSED_MESSAGE, PAYMENT_RETRY_RATE_LIMITED_MESSAGE } = await import("@/lib/checkout/messages");

const created = { orderIds: [] as string[], customerIds: [] as string[], skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[] };
const usedIps = new Set<string>();

function uniqueOrderNo(): string {
  return `ORD-209910-${randomInt(10_000_000, 99_999_999)}${randomInt(0, 9)}`;
}

function freshIp(): string {
  clientIp = `198.51.100.${randomInt(1, 254)}`;
  usedIps.add(clientIp);
  return clientIp;
}

beforeEach(async () => {
  jar.clear();
  sessionCustomerId = null;
  process.env.STOREFRONT_CART_ENABLED = "true";
  await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, freshIp()));
});

afterEach(() => {
  delete process.env.STOREFRONT_CART_ENABLED;
});

afterAll(async () => {
  await testDb.delete(cartItems).where(inArray(cartItems.sku, created.skus));
  const hashes = [...issuedCartTokens].map(hashCartToken);
  if (hashes.length > 0) await testDb.delete(carts).where(inArray(carts.tokenHash, hashes));
  await testDb.delete(carts).where(inArray(carts.customerId, created.customerIds));
  await testDb.delete(orderAccessTokens).where(inArray(orderAccessTokens.orderId, created.orderIds));
  await testDb.delete(orderItems).where(inArray(orderItems.orderId, created.orderIds));
  await testDb.delete(orders).where(inArray(orders.id, created.orderIds));
  await testDb.delete(customers).where(inArray(customers.id, created.customerIds));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, created.skus)));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
  await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...usedIps]));
});

async function sellableVariant(stock: number) {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  await testDb.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, product.id));
  if (stock > 0) await testDb.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * 100_000, type: "production", refType: "manual" });
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  return { product, variant };
}

/** A checkout order (cancelled by default, never paid) with the given lines and one view token. */
async function orderWith(lines: { sku: string; qty: number }[], overrides: Partial<typeof orders.$inferInsert> = {}) {
  const order = await insertOrder(testDb, {
    ...checkoutOrderValues(),
    orderNo: uniqueOrderNo(),
    status: "cancelled",
    paymentStatus: "expired",
    cancelReason: "payment_expired",
    cancelledAt: new Date(),
    contactEmail: `reorder-${randomUUID()}@example.test`,
    subtotalAmount: lines.reduce((sum, line) => sum + line.qty * 250_000, 0),
    totalAmount: lines.reduce((sum, line) => sum + line.qty * 250_000, 0),
    shippingAmount: 0,
    ...overrides,
  });
  created.orderIds.push(order.id);
  for (const line of lines) await testDb.insert(orderItems).values({ orderId: order.id, sku: line.sku, qty: line.qty, unitPrice: 250_000, unitCost: 0 });
  const token = generateOrderAccessToken();
  await testDb.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: hashOrderAccessToken(token), expiresAt: new Date(Date.now() + 86_400_000) });
  return { order, token };
}

async function guestCartLines(): Promise<Record<string, number>> {
  const cookie = jar.get("ammari_cart");
  if (!cookie) return {};
  const [cart] = await testDb.select({ id: carts.id }).from(carts).where(eq(carts.tokenHash, hashCartToken(cookie)));
  if (!cart) return {};
  const rows = await testDb.select({ sku: cartItems.sku, qty: cartItems.qty }).from(cartItems).where(eq(cartItems.cartId, cart.id));
  return Object.fromEntries(rows.map((row) => [row.sku, row.qty]));
}

function viewRequest(orderNo: string, token: string | null) {
  const url = new URL(`http://localhost/orders/${orderNo}`);
  if (token !== null) url.searchParams.set("t", token);
  return GET(new NextRequest(url), { params: Promise.resolve({ orderNo }) });
}

describe("the Lihat pesanan token route", () => {
  test("a valid token: 303 to the clean URL with the token in an httpOnly cookie scoped to that order; no-referrer, no body", async () => {
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }]);
    const response = await viewRequest(order.orderNo, token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/orders/${order.orderNo}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`ammari_order_view_${order.orderNo}=${token}`);
    expect(cookie).toContain(`ammari_order_views=${order.orderNo}; Path=/;`);
    expect(cookie).toContain(`Path=/orders/${order.orderNo}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toMatch(/Expires=/);
  });

  test("a wrong, expired, other order's or missing token, and an unknown order: the same redirect, never a cookie", async () => {
    const { variant } = await sellableVariant(5);
    const first = await orderWith([{ sku: variant.sku, qty: 1 }]);
    const second = await orderWith([{ sku: variant.sku, qty: 1 }]);
    const expired = generateOrderAccessToken();
    await testDb.insert(orderAccessTokens).values({ orderId: first.order.id, tokenHash: hashOrderAccessToken(expired), createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1000) });
    const unknown = uniqueOrderNo();

    for (const [orderNo, token] of [
      [first.order.orderNo, generateOrderAccessToken()],
      [first.order.orderNo, expired],
      [first.order.orderNo, second.token],
      [first.order.orderNo, "garbage"],
      [first.order.orderNo, null],
      [unknown, first.token],
    ] as const) {
      const response = await viewRequest(orderNo, token);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/orders/${orderNo}`);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    // Not an order number at all.
    expect((await viewRequest("../account", first.token)).headers.get("location")).toBe("/orders");
  });

  test(`over ${ORDER_VIEW_LIMIT} lookups per IP in 10 minutes: no lookup, a 'limited' page`, async () => {
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }]);
    await testDb.insert(claimRateLimits).values(Array.from({ length: ORDER_VIEW_LIMIT }, () => ({ ip: clientIp, action: "order_view" })));
    const response = await viewRequest(order.orderNo, token);
    expect(response.headers.get("location")).toBe(`/orders/${order.orderNo}?status=limited`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("Pesan lagi", () => {
  test("with the order's view cookie: the lines go into a new guest cart, a sold-out line is named and skipped", async () => {
    const available = await sellableVariant(5);
    const soldOut = await sellableVariant(0);
    const { order, token } = await orderWith([
      { sku: available.variant.sku, qty: 2 },
      { sku: soldOut.variant.sku, qty: 1 },
    ]);
    jar.set(`ammari_order_view_${order.orderNo}`, token);

    const result = await reorderAction(order.orderNo);
    expect(result).toMatchObject({ ok: true, pieceCount: 2, addedPieces: 2, mergeTrimmed: false });
    if (!result.ok) throw new Error("expected ok");
    expect(result.notes).toEqual([{ name: soldOut.product.name, variant: expect.stringContaining(" · M"), message: "Habis" }]);
    expect(await guestCartLines()).toEqual({ [available.variant.sku]: 2 });
  });

  test("the checkout cookie (finish page) works too; a session sees its own order without any cookie", async () => {
    const { variant } = await sellableVariant(5);
    const viaCheckout = await orderWith([{ sku: variant.sku, qty: 1 }]);
    jar.set("ammari_checkout_order", viaCheckout.token);
    expect(await reorderAction(viaCheckout.order.orderNo)).toMatchObject({ ok: true, addedPieces: 1 });

    jar.clear();
    const owner = await insertCustomer(testDb);
    created.customerIds.push(owner.id);
    const own = await orderWith([{ sku: variant.sku, qty: 1 }], { customerId: owner.id, placedWithSession: true });
    sessionCustomerId = owner.id;
    expect(await reorderAction(own.order.orderNo)).toMatchObject({ ok: true, pieceCount: 1, addedPieces: 1 });
    const [cart] = await testDb.select({ id: carts.id }).from(carts).where(eq(carts.customerId, owner.id));
    expect(cart).toBeDefined();
  });

  test("refused alike for a stranger, a wrong cookie, an unknown or malformed number, and an order that is not cancelled-unpaid", async () => {
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }]);
    const pending = await orderWith([{ sku: variant.sku, qty: 1 }], { status: "awaiting_payment", paymentStatus: "pending", cancelReason: null, cancelledAt: null });
    const refused = { ok: false, message: "Pesanan ini tidak bisa dipesan lagi dari sini." };

    expect(await reorderAction(order.orderNo)).toEqual(refused);
    jar.set(`ammari_order_view_${order.orderNo}`, generateOrderAccessToken());
    expect(await reorderAction(order.orderNo)).toEqual(refused);
    jar.clear();
    const unknown = uniqueOrderNo();
    jar.set(`ammari_order_view_${unknown}`, token);
    expect(await reorderAction(unknown)).toEqual(refused);
    // A cookie for one order never opens another.
    jar.clear();
    jar.set(`ammari_order_view_${pending.order.orderNo}`, token);
    expect(await reorderAction(order.orderNo)).toEqual(refused);
    expect(await reorderAction("ORD-1")).toEqual(refused);
    jar.set(`ammari_order_view_${pending.order.orderNo}`, pending.token);
    expect(await reorderAction(pending.order.orderNo)).toEqual(refused);
    expect(jar.has("ammari_cart")).toBe(false);
  });

  test("flag off: refused before anything is read or written", async () => {
    delete process.env.STOREFRONT_CART_ENABLED;
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }]);
    jar.set(`ammari_order_view_${order.orderNo}`, token);
    expect(await reorderAction(order.orderNo)).toEqual({ ok: false, message: "Keranjang belum tersedia." });
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp))).toHaveLength(0);
  });

  test("counts as a cart write: over the per-IP limit it is refused", async () => {
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }]);
    jar.set(`ammari_order_view_${order.orderNo}`, token);
    await testDb.insert(claimRateLimits).values(Array.from({ length: 120 }, () => ({ ip: clientIp, action: "cart_write" })));
    expect(await reorderAction(order.orderNo)).toEqual({ ok: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
  });
});

describe("payment actions and the emailed view cookie (plan §9.2)", () => {
  test("the view cookie never opens a new payment attempt; the checkout cookie still may", async () => {
    const { variant } = await sellableVariant(5);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }], { status: "awaiting_payment", paymentStatus: "pending", cancelReason: null, cancelledAt: null });
    jar.set(`ammari_order_view_${order.orderNo}`, token);
    expect(await reopenPaymentPageAction(order.orderNo)).toEqual({ ok: false, message: PAYMENT_RETRY_CLOSED_MESSAGE });

    jar.clear();
    jar.set("ammari_checkout_order", token);
    // Past the ownership check (no payment provider is configured in this test run).
    expect(await reopenPaymentPageAction(order.orderNo)).not.toEqual({ ok: false, message: PAYMENT_RETRY_CLOSED_MESSAGE });
  });

  test("Ganti metode pembayaran: never with the view cookie; the checkout cookie or the session gets past the ownership check", async () => {
    const { variant } = await sellableVariant(5);
    const customer = await insertCustomer(testDb);
    created.customerIds.push(customer.id);
    const { order, token } = await orderWith([{ sku: variant.sku, qty: 1 }], {
      status: "awaiting_payment",
      paymentStatus: "pending",
      cancelReason: null,
      cancelledAt: null,
      customerId: customer.id,
      placedWithSession: true,
    });
    const closed = { ok: false, message: PAYMENT_RETRY_CLOSED_MESSAGE, refresh: false };
    jar.set(`ammari_order_view_${order.orderNo}`, token);
    expect(await changePaymentMethodAction(order.orderNo)).toEqual(closed);

    jar.clear();
    jar.set("ammari_checkout_order", token);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await changePaymentMethodAction(order.orderNo)).not.toEqual(closed);
    jar.clear();
    sessionCustomerId = customer.id;
    expect(await changePaymentMethodAction(order.orderNo)).not.toEqual(closed);
    // A stranger's session and malformed numbers are refused alike.
    sessionCustomerId = null;
    expect(await changePaymentMethodAction(order.orderNo)).toEqual(closed);
    expect(await changePaymentMethodAction("../x")).toEqual(closed);
    warn.mockRestore();
  });

  test(`Ganti metode pembayaran: over ${PAYMENT_CHANGE_LIMIT} per IP in 10 minutes, refused before any lookup; flag off, refused`, async () => {
    await testDb.insert(claimRateLimits).values(Array.from({ length: PAYMENT_CHANGE_LIMIT }, () => ({ ip: clientIp, action: "payment_method_change" })));
    expect(await changePaymentMethodAction("ORD-209910-00000001")).toEqual({ ok: false, message: PAYMENT_RETRY_RATE_LIMITED_MESSAGE, refresh: false });
    delete process.env.STOREFRONT_CART_ENABLED;
    expect(await changePaymentMethodAction("ORD-209910-00000001")).toMatchObject({ ok: false, refresh: false });
  });
});
