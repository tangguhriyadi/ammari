import { randomBytes, randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRollback, withTriggerDisabled, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderItems, orderNotifications, orders, payments, stockMovements, stockReservations, storeSettings } from "@ammari/db/schema";
import { ResendEmailSender } from "@ammari/auth";
import { recordFakeTransaction } from "@ammari/commerce/payments";

// docs/plans/cart-checkout.md §8, D14 (session 13): the order email hooks in apps/web (the payment
// notification route, the expiry sweep route) and the cron email pass, with the fake payment
// provider, each test inside a rolled-back transaction. Emails go through the real
// ResendEmailSender over a stubbed fetch: nothing reaches Resend or Midtrans.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath, revalidateTag: vi.fn(), unstable_cache: <T,>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.41" }),
}));
// `after()` callbacks are collected and run by the test (no Next request scope here).
const scheduled: (() => Promise<unknown> | unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<unknown> | unknown) => {
    scheduled.push(callback);
  },
}));

const { __setOrderEmailSenderForTests, getOrderEmailConfig, getOrderEmailDeps } = await import("./order-emails");
const notification = await import("@/app/api/payments/midtrans/notification/route");
const sweep = await import("@/app/api/internal/payments/sweep/route");
const emailsRoute = await import("@/app/api/internal/emails/dispatch/route");

// Built at runtime: never a secret- or key-shaped literal in the repo.
const CRON_SECRET = randomBytes(24).toString("hex");
const ENV = {
  E2E_TEST_LOGIN: "true",
  PAYMENT_PROVIDER: "fake",
  MIDTRANS_ORDER_ID_PREFIX: "E2E-",
  INTERNAL_CRON_SECRET: CRON_SECRET,
  CUSTOMER_BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  ADMIN_SITE_URL: "https://admin.ammari.example",
};
const resendKey = ["test", "resend", "placeholder"].join("-");

type ResendCall = { to: string; subject: string; text: string; html: string; idempotencyKey: string | null };
let resendDown = false;
let resendCalls: ResendCall[] = [];

beforeEach(() => {
  Object.assign(process.env, ENV);
  scheduled.length = 0;
  resendCalls = [];
  resendDown = false;
  __setOrderEmailSenderForTests(new ResendEmailSender({ apiKey: resendKey, from: "Ammari <pesanan@example.test>" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
    const headers = init?.headers as Record<string, string>;
    resendCalls.push({ to: body.to[0]!, subject: body.subject, text: body.text, html: body.html, idempotencyKey: headers["Idempotency-Key"] ?? null });
    if (resendDown) return new Response(JSON.stringify({ name: "internal_server_error", message: `failed for ${body.to[0]}` }), { status: 500 });
    return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
  });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  __setOrderEmailSenderForTests(null);
  currentDb = null;
  vi.restoreAllMocks();
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

async function runScheduled(): Promise<void> {
  while (scheduled.length > 0) await scheduled.shift()!();
}

async function checkoutOrder(tx: TestTx, options: { expired?: boolean } = {}) {
  const { variant } = await insertProductVariant(tx);
  await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
  const customer = await insertCustomer(tx, { name: "Siti Aminah" });
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
    ...(options.expired ? { paymentExpiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } : {}),
  });
  const [item] = await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 }).returning();
  await tx.insert(stockReservations).values({ orderId: order.id, orderItemId: item!.id, sku: variant.sku, qty: 1, expiresAt: options.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '75 minutes'` });
  const providerOrderId = `E2E-${orderNo}-1`;
  await tx.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: 259_000, status: "pending", snapToken: "fake-token", redirectUrl: `http://localhost:3100/api/test/payments/${providerOrderId}` });
  return { orderId: order.id, orderNo, providerOrderId, email: customer.email };
}

async function setSupportEmail(tx: TestTx, email: string): Promise<void> {
  await tx.insert(storeSettings).values({ id: 1, supportEmail: email }).onConflictDoUpdate({ target: storeSettings.id, set: { supportEmail: email } });
}

function notify(body: Record<string, unknown>) {
  return notification.POST(new Request("http://localhost:3100/api/payments/midtrans/notification", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
}

function cron(route: { POST: (request: Request) => Promise<Response> }, path: string, headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return route.POST(new Request(`http://web:3000${path}`, { method: "POST", headers }));
}

const mine = (orderNo: string) => resendCalls.filter((call) => call.subject.includes(orderNo));

describe("payment notification hook", () => {
  test("duplicate settlement notifications: one paid email to the buyer and one owner email", async () => {
    await inRollback(async (tx) => {
      await setSupportEmail(tx, "pemilik@example.test");
      const fixture = await checkoutOrder(tx);
      const body = recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 });
      const answers = [await notify(body), await notify(body), await notify(body)];
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
      await runScheduled();

      expect(mine(fixture.orderNo).map((call) => [call.to, call.subject])).toEqual([
        [fixture.email, `Pembayaran pesanan ${fixture.orderNo} sudah kami terima`],
        ["pemilik@example.test", `Pesanan baru dibayar: ${fixture.orderNo}`],
      ]);
      const owner = mine(fixture.orderNo)[1]!;
      expect(owner.text).toContain(`https://admin.ammari.example/orders/${fixture.orderId}`);
      expect(owner.idempotencyKey).toMatch(/^order-email\//);
      expect(mine(fixture.orderNo)[0]!.html).toContain("Pembayaran sudah kami terima");
    });
  });

  test("Resend down: the notification still answers 200 and pays the order; the cron pass resends after the lease", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await setSupportEmail(tx, "pemilik@example.test");
      const fixture = await checkoutOrder(tx);
      resendDown = true;
      const response = await notify(recordFakeTransaction({ providerOrderId: fixture.providerOrderId, transactionStatus: "settlement", grossAmount: 259_000 }));
      expect(response.status).toBe(200);
      await runScheduled();
      const [order] = await tx.select({ status: orders.status, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, fixture.orderId));
      expect(order).toEqual({ status: "to_ship", paymentStatus: "paid" });
      const rows = await tx.select().from(orderNotifications).where(eq(orderNotifications.orderId, fixture.orderId));
      expect(rows.map((row) => row.error).sort()).toEqual(["email send failed (500, internal_server_error)", "email send failed (500, internal_server_error)"]);
      // The recorded error never carries the address Resend echoed.
      expect(JSON.stringify(rows)).not.toContain(fixture.email);

      // Still down on the next cron tick (inside the lease: not retried yet, answers 200).
      expect((await cron(emailsRoute, "/api/internal/emails/dispatch")).status).toBe(200);
      expect(mine(fixture.orderNo)).toHaveLength(2);

      resendDown = false;
      await withTriggerDisabled(tx, "order_notifications", "set_updated_at", () =>
        tx.update(orderNotifications).set({ updatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(orderNotifications.orderId, fixture.orderId)),
      );
      const retry = await cron(emailsRoute, "/api/internal/emails/dispatch");
      expect(retry.status).toBe(200);
      const calls = mine(fixture.orderNo);
      expect(calls).toHaveLength(4);
      // Same payload and idempotency key as the failed attempt.
      const buyer = calls.filter((call) => call.to === fixture.email);
      expect(buyer[1]).toEqual(buyer[0]);
    });
  });
});

describe("expiry sweep hook", () => {
  test("an order the sweep expires gets one cancelled email, even across repeated sweeps and email passes", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fixture = await checkoutOrder(tx, { expired: true });
      expect((await cron(sweep, "/api/internal/payments/sweep")).status).toBe(200);
      await runScheduled();
      expect((await cron(sweep, "/api/internal/payments/sweep")).status).toBe(200);
      await runScheduled();
      expect((await cron(emailsRoute, "/api/internal/emails/dispatch")).status).toBe(200);
      const calls = mine(fixture.orderNo);
      expect(calls.map((call) => call.subject)).toEqual([`Pesanan ${fixture.orderNo} dibatalkan`]);
      expect(calls[0]!.to).toBe(fixture.email);
      expect(calls[0]!.text).toMatch(new RegExp(`/orders/${fixture.orderNo}\\?t=[A-Za-z0-9_-]{43}`));
    });
  });
});

describe("POST /api/internal/emails/dispatch", () => {
  test("cron auth: wrong or missing bearer 401, through a proxy 404, emails not configured 503", async () => {
    await inRollback(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await cron(emailsRoute, "/api/internal/emails/dispatch", {})).status).toBe(401);
      expect((await cron(emailsRoute, "/api/internal/emails/dispatch", { authorization: `Bearer ${CRON_SECRET}x` })).status).toBe(401);
      expect((await cron(emailsRoute, "/api/internal/emails/dispatch", { authorization: `Bearer ${CRON_SECRET}`, "cf-connecting-ip": "203.0.113.5" })).status).toBe(404);
      delete process.env.CUSTOMER_BETTER_AUTH_SECRET;
      const refused = await cron(emailsRoute, "/api/internal/emails/dispatch");
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "order emails not configured", problems: ["CUSTOMER_BETTER_AUTH_SECRET"] });
      expect(JSON.stringify(errors.mock.calls)).not.toContain(CRON_SECRET);
    });
  });
});

describe("getOrderEmailDeps", () => {
  test("production without Resend: no deps, problems logged by variable name only", () => {
    __setOrderEmailSenderForTests(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("BETTER_AUTH_URL", "https://ammari.example");
    delete process.env.E2E_TEST_LOGIN;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(getOrderEmailDeps()).toBeNull();
      expect(errors).toHaveBeenCalledWith("[emails] order email configuration problem", { problems: ["RESEND_API_KEY", "EMAIL_FROM"] });
      expect(JSON.stringify(errors.mock.calls)).not.toContain(ENV.CUSTOMER_BETTER_AUTH_SECRET);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("production with a localhost or missing storefront origin sends nothing (never dead links recorded as sent)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = getOrderEmailConfig();
      expect(config.deps).toBeNull();
      expect(config.problems).toContain("BETTER_AUTH_URL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a bad ADMIN_SITE_URL only drops the admin link", () => {
    process.env.ADMIN_SITE_URL = "javascript:alert(1)";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = getOrderEmailDeps();
    expect(deps).not.toBeNull();
    expect(deps!.adminOrigin).toBeNull();
  });
});
