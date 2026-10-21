import { randomInt, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderAccessTokens, orderItems, orders, paymentNotifications, payments, stockMovements, stockReservations } from "@ammari/db/schema";
import { generateOrderAccessToken, hashOrderAccessToken } from "@ammari/commerce/checkout";
import { midtransSignature, recordFakeTransaction } from "@ammari/commerce/payments";

// docs/plans/cart-checkout.md §6.1, §4.4, session 11: the notification route, the finish page's
// status check and retry actions, and the e2e fake gateway's test buttons, with the fake payment
// provider (PAYMENT_PROVIDER=fake behind the e2e gate) and each test inside a rolled-back
// transaction. Nothing here reaches Midtrans.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
  headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }),
}));
const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath, revalidateTag, unstable_cache: <T,>(fn: T) => fn }));
// The order email hooks have their own tests (lib/emails/order-emails.test.ts).
vi.mock("@/lib/emails/order-emails", () => ({ scheduleOrderEmails: vi.fn() }));
vi.mock("@/lib/auth/customer-session", () => ({ getCustomerSession: async () => null }));

const { POST } = await import("./route");
const { checkPaymentStatusAction, reopenPaymentPageAction } = await import("@/lib/checkout/payment-actions");
const fakePage = await import("../../../test/payments/[providerOrderId]/route");

const ENV = { STOREFRONT_CART_ENABLED: "true", E2E_TEST_LOGIN: "true", PAYMENT_PROVIDER: "fake", MIDTRANS_ORDER_ID_PREFIX: "E2E-" };

beforeEach(() => {
  Object.assign(process.env, ENV);
  jar.clear();
  revalidatePath.mockClear();
});
afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  vi.unstubAllEnvs();
  currentDb = null;
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

async function checkoutOrder(tx: TestTx, options: { withPage?: boolean } = {}) {
  const { product, variant } = await insertProductVariant(tx);
  await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
  const customer = await insertCustomer(tx);
  const orderNo = `ORD-2099${randomInt(10, 99)}-${randomInt(10_000_000, 99_999_999)}`;
  const order = await insertOrder(tx, {
    ...checkoutOrderValues(),
    ...shippingQuoteValues(12_000),
    orderNo,
    customerId: customer.id,
    subtotalAmount: 259_000,
    discountAmount: 0,
    totalAmount: 259_000,
    contactEmail: customer.email,
    contactPhone: "+6281234567890",
    recipientName: "Siti Aminah",
  });
  const [item] = await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 }).returning();
  await tx.insert(stockReservations).values({ orderId: order.id, orderItemId: item!.id, sku: variant.sku, qty: 1, expiresAt: sql`now() + interval '75 minutes'` });
  const providerOrderId = `E2E-${orderNo}-1`;
  await tx.insert(payments).values({
    orderId: order.id,
    provider: "midtrans",
    providerOrderId,
    attempt: 1,
    grossAmount: 259_000,
    status: "created",
    // Without a page: a request that ended a minute ago (not still in flight).
    ...(options.withPage === false ? { createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000) } : { snapToken: "fake-token", redirectUrl: `http://localhost:3100/api/test/payments/${providerOrderId}` }),
  });
  const token = generateOrderAccessToken();
  await tx.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: hashOrderAccessToken(token), expiresAt: sql`now() + interval '120 days'` });
  return { orderId: order.id, orderNo, providerOrderId, slug: product.slug, token };
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST(new Request("http://localhost:3100/api/payments/midtrans/notification", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
}

async function orderStatus(tx: TestTx, orderId: string) {
  const [row] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId));
  return row;
}

describe("POST /api/payments/midtrans/notification", () => {
  test("a verified settlement pays the order, answers 200 and revalidates the product page", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const response = await post(JSON.stringify(recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 })));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "to_ship", paymentStatus: "paid" });
      expect(revalidatePath).toHaveBeenCalledWith(`/products/${fixture.slug}`);
    });
  });

  test("works with the cart flag off (plan §14: orders placed before a rollback still settle)", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      process.env.STOREFRONT_CART_ENABLED = "false";
      const response = await post(JSON.stringify(recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 })));
      expect(response.status).toBe(200);
      expect((await orderStatus(tx, fixture.orderId))?.paymentStatus).toBe("paid");
    });
  });

  test("a bad signature is 403 and changes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const body = recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 });
      const forged = { ...body, signature_key: midtransSignature({ orderId: body.order_id!, statusCode: body.status_code!, grossAmount: body.gross_amount! }, "not-the-key") };
      expect((await post(JSON.stringify(forged))).status).toBe(403);
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("a body over 32 KB (declared or streamed) is refused before parsing, still logged; a non-JSON body is 400", async () => {
    await inRollback(async (tx) => {
      const refusedRows = async () =>
        tx.select().from(paymentNotifications).where(sql`${paymentNotifications.payload} ->> 'refused' = 'too_large'`);
      const before = (await refusedRows()).length;
      expect((await post("{}", { "content-length": String(64 * 1024) })).status).toBe(400);
      const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
      const streamed = await POST(new Request("http://localhost:3100/api/payments/midtrans/notification", { method: "POST", body: stream, duplex: "half" } as RequestInit));
      expect(streamed.status).toBe(400);
      expect((await refusedRows()).length).toBe(before + 2);

      const malformed = await post("not json");
      expect(malformed.status).toBe(400);
      // The answer never says why.
      expect(await malformed.text()).toBe("refused");
    });
  });

  test("without a configured provider: 503 (retried by the gateway) and logged", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      const body = JSON.stringify(recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 }));
      delete process.env.PAYMENT_PROVIDER;
      vi.stubEnv("MIDTRANS_SERVER_KEY", "");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await post(body)).status).toBe(503);
      const logged = await tx.select().from(paymentNotifications).where(eq(paymentNotifications.providerOrderId, fixture.providerOrderId));
      expect(logged).toMatchObject([{ result: "not_configured", signatureValid: false }]);
      expect((await orderStatus(tx, fixture.orderId))?.paymentStatus).toBe("pending");
    });
  });
});

describe("finish page actions", () => {
  test("the status check applies the gateway's status for the buyer (checkout cookie) only", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 });

      // A stranger (no cookie) cannot trigger anything.
      expect(await checkPaymentStatusAction(fixture.orderNo)).toEqual({ changed: false });
      expect((await orderStatus(tx, fixture.orderId))?.paymentStatus).toBe("pending");

      jar.set("ammari_checkout_order", fixture.token);
      expect(await checkPaymentStatusAction(fixture.orderNo)).toEqual({ changed: true });
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "to_ship", paymentStatus: "paid" });
      expect(revalidatePath).toHaveBeenCalledWith(`/products/${fixture.slug}`);
      expect(await checkPaymentStatusAction(fixture.orderNo)).toEqual({ changed: false });

      process.env.STOREFRONT_CART_ENABLED = "false";
      expect(await checkPaymentStatusAction(fixture.orderNo)).toEqual({ changed: false });
    });
  });

  test("the retry opens a new attempt for the buyer; a stranger or a malformed number is refused", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx, { withPage: false });
      expect(await reopenPaymentPageAction(fixture.orderNo)).toMatchObject({ ok: false });
      expect(await reopenPaymentPageAction("../etc")).toMatchObject({ ok: false });

      jar.set("ammari_checkout_order", fixture.token);
      const result = await reopenPaymentPageAction(fixture.orderNo);
      expect(result).toEqual({ ok: true, redirectUrl: expect.stringMatching(new RegExp(`/api/test/payments/E2E-${fixture.orderNo}-2$`)) });
      const attempts = await tx.select({ attempt: payments.attempt }).from(payments).where(eq(payments.orderId, fixture.orderId));
      expect(attempts.map((row) => row.attempt).sort()).toEqual([1, 2]);
    });
  });
});

describe("fake gateway test buttons (e2e only)", () => {
  function press(providerOrderId: string, status: string, host = "localhost:3100") {
    const request = new NextRequest(`http://${host}/api/test/payments/${providerOrderId}`, {
      method: "POST",
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status }).toString(),
    });
    return fakePage.POST(request, { params: Promise.resolve({ providerOrderId }) });
  }

  test("'Bayar (uji)' goes through the real notification route (signed, status re-fetched) and lands on the finish page", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      // The page posts to this server's own route; here that call is handed to the route directly.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        expect(String(url)).toBe("http://localhost:3100/api/payments/midtrans/notification");
        return POST(new Request(String(url), init));
      });
      const response = await press(fixture.providerOrderId, "settlement");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/checkout/finish?order=${fixture.orderNo}`);
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "to_ship", paymentStatus: "paid" });
      const [log] = await tx.select().from(paymentNotifications).where(and(eq(paymentNotifications.providerOrderId, fixture.providerOrderId), eq(paymentNotifications.signatureValid, true)));
      expect(log?.result).toBe("paid");
    });
  });

  test("404 outside the gate, with a real provider, or for an unknown action", async () => {
    await inRollback(async (tx) => {
      const fixture = await checkoutOrder(tx);
      expect((await press(fixture.providerOrderId, "settlement", "ammari.my.id")).status).toBe(404);
      expect((await press(fixture.providerOrderId, "refund")).status).toBe(404);
      expect((await press(`E2E-ORD-209901-${randomUUID().slice(0, 4).replace(/\D/g, "1")}9999-1`, "settlement")).status).toBe(404);
      process.env.PAYMENT_PROVIDER = "midtrans";
      expect((await press(fixture.providerOrderId, "settlement")).status).toBe(404);
      expect((await orderStatus(tx, fixture.orderId))?.paymentStatus).toBe("pending");
    });
  });
});
