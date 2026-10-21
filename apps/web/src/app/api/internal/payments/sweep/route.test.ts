import { randomBytes, randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { claimRateLimits, orderItems, orders, payments, stockMovements, stockReservations } from "@ammari/db/schema";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { recordFakeTransaction } from "@ammari/commerce/payments";

// docs/plans/cart-checkout.md §6.3, §11, session 12: the internal cron routes (payment expiry
// sweep, retention) with the fake payment provider (PAYMENT_PROVIDER=fake behind the e2e gate),
// each test inside a rolled-back transaction. Nothing here reaches Midtrans.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));
const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath, revalidateTag, unstable_cache: <T,>(fn: T) => fn }));

const sweep = await import("./route");
const retention = await import("../../retention/route");

// Built at runtime: never a secret-shaped literal in the repo.
const SECRET = randomBytes(24).toString("hex");
const ENV = { E2E_TEST_LOGIN: "true", PAYMENT_PROVIDER: "fake", INTERNAL_CRON_SECRET: SECRET };

beforeEach(() => {
  Object.assign(process.env, ENV);
  revalidatePath.mockClear();
  revalidateTag.mockClear();
});
afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  delete process.env.STOREFRONT_CART_ENABLED;
  currentDb = null;
  vi.restoreAllMocks();
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

/** A checkout order whose payment window and stock hold are both over; its one attempt has a page
 * but the (fake) gateway has no transaction for it unless the test records one. */
async function expiredCheckoutOrder(tx: TestTx) {
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
    paymentExpiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  const [item] = await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 }).returning();
  await tx.insert(stockReservations).values({ orderId: order.id, orderItemId: item!.id, sku: variant.sku, qty: 1, expiresAt: sql`now() - interval '1 minute'` });
  const providerOrderId = `E2E-${orderNo}-1`;
  await tx.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: 259_000, status: "pending", snapToken: "fake-token", redirectUrl: `http://localhost:3100/api/test/payments/${providerOrderId}` });
  return { orderId: order.id, orderNo, providerOrderId, slug: product.slug };
}

function call(route: { POST: (request: Request) => Promise<Response> }, path: string, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return route.POST(new Request(`http://web:3000${path}`, { method: "POST", headers }));
}

async function orderStatus(tx: TestTx, orderId: string) {
  const [row] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus, cancelReason: orders.cancelReason }).from(orders).where(eq(orders.id, orderId));
  return row;
}

describe("internal cron route authentication", () => {
  test.each([
    ["/api/internal/payments/sweep", sweep],
    ["/api/internal/retention", retention],
  ] as const)("%s: no secret configured 503, short secret 503, missing or wrong bearer 401, through a proxy 404", async (path, route) => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      delete process.env.INTERNAL_CRON_SECRET;
      expect((await call(route, path)).status).toBe(503);
      process.env.INTERNAL_CRON_SECRET = "too-short";
      expect((await call(route, path, { authorization: "Bearer too-short" })).status).toBe(503);
      process.env.INTERNAL_CRON_SECRET = SECRET;

      expect((await call(route, path, {})).status).toBe(401);
      expect((await call(route, path, { authorization: `Bearer ${SECRET}x` })).status).toBe(401);
      expect((await call(route, path, { authorization: SECRET })).status).toBe(401);
      expect((await call(route, path, { authorization: `Bearer ${SECRET}`, "cf-connecting-ip": "203.0.113.5" })).status).toBe(404);
      expect((await call(route, path, { authorization: `Bearer ${SECRET}`, "x-forwarded-for": "203.0.113.5" })).status).toBe(404);

      // Nothing ran, and no log line carries the secret.
      expect(await orderStatus(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
    });
  });
});

describe("POST /api/internal/payments/sweep", () => {
  test("expires an order whose hold is over and that has no live transaction, with the cart flag off, and revalidates its product page", async () => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      process.env.STOREFRONT_CART_ENABLED = "false";
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const response = await call(sweep, "/api/internal/payments/sweep");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ finalized: expect.any(Number), results: { expired_locally: expect.any(Number) } });
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      expect(revalidatePath).toHaveBeenCalledWith(`/products/${fixture.slug}`);
    });
  });

  test("a transaction still pending at the fake gateway is expired there first", async () => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "pending", grossAmount: 259_000 });
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      expect((await call(sweep, "/api/internal/payments/sweep")).status).toBe(200);
      expect(await orderStatus(tx, fixture.orderId)).toEqual({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
      const [payment] = await tx.select({ lastStatus: payments.lastStatus }).from(payments).where(eq(payments.providerOrderId, fixture.providerOrderId));
      expect(payment?.lastStatus).toMatchObject({ transaction_status: "expire" });
    });
  });

  test("an order the gateway cannot be asked about makes the run answer 502 (still counted, nothing ended)", async () => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { createFakePaymentProvider, PaymentProviderError } = await import("@ammari/commerce/payments");
      const runtime = await import("@/lib/payments/runtime");
      vi.spyOn(runtime, "getPaymentProvider").mockReturnValue({
        ...createFakePaymentProvider({ baseUrl: "http://localhost:3100" }),
        getPaymentStatus: async () => {
          throw new PaymentProviderError("unavailable", "down");
        },
      });
      const response = await call(sweep, "/api/internal/payments/sweep");
      expect(response.status).toBe(502);
      expect((await response.json()).results.gateway_unavailable).toBeGreaterThanOrEqual(1);
      expect(await orderStatus(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
    });
  });

  test("without a payment provider it answers 503 and touches nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      delete process.env.PAYMENT_PROVIDER;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("MIDTRANS_SERVER_KEY", "");
      expect((await call(sweep, "/api/internal/payments/sweep")).status).toBe(503);
      expect(await orderStatus(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      vi.unstubAllEnvs();
    });
  });

  test("a run while another holds the lock is skipped (200, nothing done)", async () => {
    await inRollback(async (tx) => {
      const fixture = await expiredCheckoutOrder(tx);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      let release: () => void = () => undefined;
      const blocker = new Promise<void>((resolve) => (release = resolve));
      // Another run, on its own committed connection.
      const other = withExclusiveRun(testDb, "paymentSweep", () => blocker);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await call(sweep, "/api/internal/payments/sweep");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ skipped: "running" });
        expect(await orderStatus(tx, fixture.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
      } finally {
        release();
        await other;
      }
    });
  });
});

describe("POST /api/internal/retention", () => {
  test("prunes old rate-limit rows and answers the counts", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const [old] = await tx.insert(claimRateLimits).values({ ip: "0.0.0.0", action: "shipping_rates", createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }).returning();
      const response = await call(retention, "/api/internal/retention");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ failed: [], truncated: [] });
      expect(body.deleted.claim_rate_limits).toBeGreaterThanOrEqual(1);
      expect(await tx.select().from(claimRateLimits).where(eq(claimRateLimits.id, old!.id))).toEqual([]);
    });
  });
});
