import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { fabricColors, fabrics, orderItems, orders, payments, products, productVariants } from "@ammari/db/schema";

// docs/plans/cart-checkout.md §13, session 10: the e2e-only stand-in for the gateway's payment
// page. Gated like the fixtures route, read-only, and showing the same lines the gateway gets.

vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));

const { GET } = await import("./route");

const ENV = { STOREFRONT_CART_ENABLED: "true", E2E_TEST_LOGIN: "true", PAYMENT_PROVIDER: "fake" };
const created = { orderIds: [] as string[], skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[] };

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
});
afterAll(async () => {
  if (created.orderIds.length > 0) {
    await testDb.delete(payments).where(inArray(payments.orderId, created.orderIds));
    await testDb.delete(orders).where(inArray(orders.id, created.orderIds));
  }
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
});

let sequence = 0;

/** A Rp259.000 line, Rp95.000 courier cost (buyer Rp75.000), a Rp20.000 voucher, and attempt 1. */
async function orderWithPayment(): Promise<{ orderNo: string; providerOrderId: string; orderId: string }> {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  sequence += 1;
  const orderNo = `ORD-209911-${Date.now().toString().slice(-7)}${sequence}`;
  const quote = shippingQuoteValues(95_000);
  const order = await insertOrder(testDb, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo,
    subtotalAmount: 259_000,
    discountAmount: 20_000,
    totalAmount: 259_000 + 75_000 - 20_000,
  });
  created.orderIds.push(order.id);
  await testDb.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });
  const providerOrderId = `E2E-${orderNo}-1`;
  await testDb.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: order.totalAmount, status: "created" });
  return { orderNo, providerOrderId, orderId: order.id };
}

function get(providerOrderId: string, host = "localhost:3100") {
  const request = new NextRequest(`http://${host}/api/test/payments/${encodeURIComponent(providerOrderId)}`, { headers: { host } });
  return GET(request, { params: Promise.resolve({ providerOrderId }) });
}

describe("GET /api/test/payments/[providerOrderId]", () => {
  test("shows the order, the product, Ongkir and Voucher lines and the total, and links back to the finish page", async () => {
    const { orderNo, providerOrderId } = await orderWithPayment();
    const response = await get(providerOrderId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(orderNo);
    expect(html).toMatch(/data-line-id="SHIPPING"><td>Ongkir<\/td><td>1<\/td><td>Rp75\.000/);
    expect(html).toMatch(/data-line-id="VOUCHER"><td>Voucher<\/td><td>1<\/td><td>-Rp20\.000/);
    expect(html).toContain("Rp314.000");
    expect(html).toContain(`href="/checkout/finish?order=${orderNo}"`);
  });

  test("never writes: the order and the payment attempt are unchanged after a visit", async () => {
    const { providerOrderId, orderId } = await orderWithPayment();
    const before = await testDb.select().from(orders).where(eq(orders.id, orderId));
    const paymentBefore = await testDb.select().from(payments).where(eq(payments.orderId, orderId));
    await get(providerOrderId);
    expect(await testDb.select().from(orders).where(eq(orders.id, orderId))).toEqual(before);
    expect(await testDb.select().from(payments).where(eq(payments.orderId, orderId))).toEqual(paymentBefore);
  });

  test("404 outside the gate: no e2e flag, production build, a non-loopback host, flag off, unknown or malformed ids", async () => {
    const { providerOrderId } = await orderWithPayment();
    delete process.env.E2E_TEST_LOGIN;
    expect((await get(providerOrderId)).status).toBe(404);
    process.env.E2E_TEST_LOGIN = "true";

    vi.stubEnv("NODE_ENV", "production");
    expect((await get(providerOrderId)).status).toBe(404);
    vi.unstubAllEnvs();

    expect((await get(providerOrderId, "ammari.my.id")).status).toBe(404);

    delete process.env.STOREFRONT_CART_ENABLED;
    expect((await get(providerOrderId)).status).toBe(404);
    process.env.STOREFRONT_CART_ENABLED = "true";

    expect((await get(`E2E-ORD-209911-${randomUUID().slice(0, 4).replace(/\D/g, "1")}9999-1`)).status).toBe(404);
    expect((await get("<script>")).status).toBe(404);
  });
});
