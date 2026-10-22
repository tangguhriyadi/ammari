import { randomBytes, randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderItems, orders, shipmentEvents, shipments, shippingWebhookEvents } from "@ammari/db/schema";

// docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling" (K3): the courier webhook route,
// the gated "advance shipment" test route that posts through it, and the tracking poller route,
// with the fake courier (SHIPPING_ORDER_PROVIDER=fake behind the e2e gate) and each test inside a
// rolled-back transaction. Nothing here reaches Biteship.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));
const scheduleOrderEmails = vi.fn();
vi.mock("@/lib/emails/order-emails", () => ({ scheduleOrderEmails }));
// `after()` callbacks are collected and run by the test, as Next runs them after the answer.
const pending: (() => Promise<void>)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<void>) => {
    pending.push(callback);
  },
}));

// The route waits out the 2-minute read window with node:timers/promises; the test decides what
// "waiting" does (the rolled-back transaction's now() is frozen, so it backdates the last read).
let onSleep: (ms: number) => Promise<void> = async () => undefined;
const sleeps: number[] = [];
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async (ms: number) => {
    sleeps.push(ms);
    await onSleep(ms);
  },
}));

const webhook = await import("./route");
const advance = await import("../../../../test/shipments/advance/route");
const poll = await import("../../../../internal/shipping/poll/route");

// Built at runtime: never a secret-shaped literal in the repo.
const PATH_TOKEN = randomBytes(24).toString("hex");
const HEADER_SECRET = randomBytes(24).toString("hex");
const CRON_SECRET = randomBytes(24).toString("hex");
const ENV = {
  E2E_TEST_LOGIN: "true",
  SHIPPING_ORDER_PROVIDER: "fake",
  BITESHIP_WEBHOOK_PATH_TOKEN: PATH_TOKEN,
  BITESHIP_WEBHOOK_HEADER_NAME: "X-Ammari-Courier",
  BITESHIP_WEBHOOK_HEADER_SECRET: HEADER_SECRET,
  INTERNAL_CRON_SECRET: CRON_SECRET,
};

beforeEach(() => {
  Object.assign(process.env, ENV);
  pending.length = 0;
  sleeps.length = 0;
  onSleep = async () => undefined;
  scheduleOrderEmails.mockClear();
});
afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  currentDb = null;
  vi.restoreAllMocks();
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

async function runAfter(): Promise<void> {
  while (pending.length > 0) await pending.shift()!();
}

/** A paid web order in to_ship with a booked attempt, as admin's "Pesan kurir" leaves it. */
async function bookedOrder(tx: TestTx) {
  const { variant } = await insertProductVariant(tx);
  const orderNo = `ORD-209907-${randomInt(10_000_000, 99_999_999)}`;
  const order = await insertOrder(tx, {
    ...checkoutOrderValues(),
    ...shippingQuoteValues(12_000),
    orderNo,
    status: "to_ship",
    paymentStatus: "paid",
    paidAt: new Date(),
    subtotalAmount: 259_000,
    shippingAmount: 0,
    totalAmount: 259_000,
  });
  await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 });
  const providerOrderId = randomBytes(12).toString("hex");
  const [shipment] = await tx
    .insert(shipments)
    .values({ orderId: order.id, attempt: 1, referenceId: `E2E-${orderNo}-K1`, provider: "biteship", providerOrderId, courier: "jne", service: "reg", awb: `E2E${randomInt(1_000_000_000, 9_999_999_999)}000`, costAmount: 12_000, status: "pickup_requested", providerStatus: "confirmed", bookedAt: new Date() })
    .returning();
  return { order, shipment: shipment! };
}

function post(token: string, body: string, headers: Record<string, string> = { "x-ammari-courier": HEADER_SECRET }) {
  return webhook.POST(new Request(`http://localhost:3100/api/shipping/biteship/webhook/${token}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), {
    params: Promise.resolve({ token }),
  });
}

async function webhookRows(tx: TestTx) {
  return tx.select().from(shippingWebhookEvents);
}

describe("POST /api/shipping/biteship/webhook/<token>", () => {
  test("answers 200 to everything; logs and re-fetches only a post with the right path token and header", async () => {
    await inRollback(async (tx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { order, shipment } = await bookedOrder(tx);
      const before = (await webhookRows(tx)).length;
      const body = JSON.stringify({ event: "order.status", order_id: shipment.providerOrderId, status: "delivered" });

      for (const response of [await post("wrong-token", body), await post(PATH_TOKEN, body, {}), await post(PATH_TOKEN, body, { "x-ammari-courier": "nope" })]) {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ok");
      }
      expect(pending).toHaveLength(0);
      expect(await webhookRows(tx)).toHaveLength(before);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(HEADER_SECRET);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(shipment.providerOrderId!);

      // Authenticated: logged as sent; the fake has no such order yet, so the re-fetch fails and
      // nothing on the order changes (the body's "delivered" is never trusted).
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await post(PATH_TOKEN, body);
      expect(response.status).toBe(200);
      const [row] = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.providerOrderId, shipment.providerOrderId!));
      expect(row).toMatchObject({ event: "order.status", payload: JSON.parse(body), processedAt: null });
      await runAfter();
      const [processed] = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.id, row!.id));
      expect(processed).toMatchObject({ result: "failed", shipmentId: shipment.id });
      expect((await tx.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("to_ship");
    });
  });

  test("one log line per post: the auth result, never the token, the header value or the body", async () => {
    await inRollback(async (tx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { shipment } = await bookedOrder(tx);
      const body = JSON.stringify({ event: "order.status", order_id: shipment.providerOrderId, status: "picked", courier_driver_name: "Budi Santoso" });
      await post("wrong-token", body);
      await post(PATH_TOKEN, body, {});
      await post(PATH_TOKEN, body, { "x-ammari-courier": "nope" });
      const lines = () => [...warn.mock.calls, ...info.mock.calls].filter(([message]) => message === "[shipping] courier webhook");
      expect(lines().map(([, fields]) => (fields as { auth: string }).auth)).toEqual(["bad_path", "missing_header", "bad_header"]);
      expect(lines().every(([, fields]) => (fields as { contentType: string }).contentType === "application/json")).toBe(true);

      await post(PATH_TOKEN, body);
      expect(lines()).toHaveLength(3); // the authenticated post's line comes once it is processed
      await runAfter();
      expect(lines()).toHaveLength(4);
      expect(lines()[3]![1]).toMatchObject({ auth: "ok", event: "order.status", format: "json", claimedStatus: "picked", providerOrderId: shipment.providerOrderId, shipment: "found", fetch: "fetched", result: "failed" });
      const everything = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
      for (const secret of [PATH_TOKEN, HEADER_SECRET, "Budi Santoso", "courier_driver_name"]) expect(everything).not.toContain(secret);
    });
  });

  test("Biteship's three status steps seconds apart: the post inside the read window waits, then ships the order", async () => {
    await inRollback(async (tx) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { order, shipment } = await bookedOrder(tx);
      const { createFakeShipmentProvider } = await import("@ammari/commerce/shipping");
      const fake = createFakeShipmentProvider();
      fake.controls.adopt({ providerOrderId: shipment.providerOrderId!, referenceId: shipment.referenceId, waybillId: shipment.awb, courierCode: "jne", serviceCode: "reg", price: 12_000, providerStatus: "confirmed" });
      const step = (status: string) => post(PATH_TOKEN, JSON.stringify({ event: "order.status", order_id: shipment.providerOrderId, status }));

      // allocated: read at once, nothing to do for the order yet.
      fake.controls.advance(shipment.providerOrderId!, "allocated");
      await step("allocated");
      await runAfter();
      expect((await tx.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("to_ship");

      // picking_up and picked arrive inside that read's 2 minutes.
      fake.controls.advance(shipment.providerOrderId!, "picking_up");
      await step("picking_up");
      fake.controls.advance(shipment.providerOrderId!, "picked");
      await step("picked");
      let windowEnded = false;
      onSleep = async () => {
        if (windowEnded) return;
        windowEnded = true;
        await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, shipment.id));
      };
      await runAfter();
      expect(sleeps).toHaveLength(2);
      expect((await tx.select().from(orders).where(eq(orders.id, order.id)))[0]).toMatchObject({ status: "shipped", trackingNumber: shipment.awb });
      expect(scheduleOrderEmails).toHaveBeenCalledWith([{ orderNo: order.orderNo }], "shipping webhook");
      const lines = info.mock.calls.filter(([message]) => message === "[shipping] courier webhook").map(([, fields]) => fields as { fetch: string; orderTransitions: string[] });
      expect(lines.map((line) => line.fetch)).toEqual(["fetched", "deferred", "debounced"]);
      expect(lines[1]!.orderTransitions).toEqual(["shipped"]);
    });
  });

  test("a form-encoded post is read like a JSON one", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { shipment } = await bookedOrder(tx);
      const body = new URLSearchParams({ event: "order.status", order_id: shipment.providerOrderId!, status: "picked" }).toString();
      await post(PATH_TOKEN, body, { "x-ammari-courier": HEADER_SECRET, "content-type": "application/x-www-form-urlencoded" });
      await runAfter();
      const [row] = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.providerOrderId, shipment.providerOrderId!));
      expect(row).toMatchObject({ event: "order.status", shipmentId: shipment.id, payload: { event: "order.status", order_id: shipment.providerOrderId, status: "picked" } });
    });
  });

  test("an empty, odd or oversized body still answers 200; oversized ones are not stored", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const before = (await webhookRows(tx)).length;
      expect((await post(PATH_TOKEN, "")).status).toBe(200);
      expect((await post(PATH_TOKEN, "not json")).status).toBe(200);
      expect((await post(PATH_TOKEN, "x".repeat(40 * 1024))).status).toBe(200);
      await runAfter();
      const rows = (await webhookRows(tx)).slice(before);
      expect(rows.map((row) => [row.rawText, row.result])).toEqual([
        [null, "no_order_id"],
        ["not json", "no_order_id"],
      ]);
    });
  });

  test("without its configuration every post is ignored (still 200), logged once", async () => {
    await inRollback(async (tx) => {
      delete process.env.BITESHIP_WEBHOOK_HEADER_SECRET;
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const before = (await webhookRows(tx)).length;
      expect((await post(PATH_TOKEN, "{}")).status).toBe(200);
      expect((await post(PATH_TOKEN, "{}")).status).toBe(200);
      expect(await webhookRows(tx)).toHaveLength(before);
      expect(error.mock.calls.filter(([message]) => String(message).includes("not configured"))).toHaveLength(1);
      expect(JSON.stringify(error.mock.calls)).toContain("BITESHIP_WEBHOOK_HEADER_SECRET");
    });
  });
});

function advanceRequest(body: unknown, host = "localhost:3100") {
  return new NextRequest(`http://${host}/api/test/shipments/advance`, { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/test/shipments/advance (e2e only)", () => {
  test("moves the fake courier on and posts through the real webhook: picked ships the order, delivered completes it", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const { order, shipment } = await bookedOrder(tx);
      const picked = await advance.POST(advanceRequest({ orderNo: order.orderNo, status: "picked" }));
      expect(picked.status).toBe(202);
      expect(await picked.json()).toMatchObject({ webhookStatus: 200, providerOrderId: shipment.providerOrderId });
      await runAfter();
      expect((await tx.select().from(orders).where(eq(orders.id, order.id)))[0]).toMatchObject({ status: "shipped", trackingNumber: shipment.awb, courier: "JNE Reguler" });
      expect(scheduleOrderEmails).toHaveBeenCalledWith([{ orderNo: order.orderNo }], "shipping webhook");

      // A re-weigh and delivery in the next step (the debounce is reset by the test route).
      await advance.POST(advanceRequest({ orderNo: order.orderNo, status: "delivered", price: 30_000 }));
      await runAfter();
      expect((await tx.select().from(orders).where(eq(orders.id, order.id)))[0]).toMatchObject({ status: "completed", needsAttention: ["shipping_cost_over_quote"] });
      expect((await tx.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipment.id))).map((event) => event.providerStatus)).toEqual(
        expect.arrayContaining(["picked", "delivered"]),
      );
    });
  });

  test("closed outside an e2e run, to a non-loopback host, and without the fake courier", async () => {
    await inRollback(async () => {
      expect((await advance.POST(advanceRequest({ orderNo: "ORD-209907-00000001", status: "picked" }, "ammari.my.id"))).status).toBe(404);
      process.env.E2E_TEST_LOGIN = "false";
      expect((await advance.POST(advanceRequest({ orderNo: "ORD-209907-00000001", status: "picked" }))).status).toBe(404);
      process.env.E2E_TEST_LOGIN = "true";
      delete process.env.SHIPPING_ORDER_PROVIDER;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await advance.POST(advanceRequest({ orderNo: "ORD-209907-00000001", status: "picked" }))).status).toBe(409);
    });
  });
});

function pollCall(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return poll.POST(new Request("http://web:3000/api/internal/shipping/poll", { method: "POST", headers }));
}

describe("POST /api/internal/shipping/poll", () => {
  test("only the cron service may call it", async () => {
    await inRollback(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await pollCall({})).status).toBe(401);
      expect((await pollCall({ authorization: `Bearer ${CRON_SECRET}`, "x-ammari-proxy": "caddy" })).status).toBe(404);
    });
  });

  test("reads open shipments with the fake courier and sends the emails of the orders it moved", async () => {
    await inRollback(async (tx) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      // Only this test's shipment is readable (rolled back afterwards).
      await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date() });
      const { order, shipment } = await bookedOrder(tx);
      // Admin booked it in "another process": the fake learns it, and the courier picks it up.
      const { createFakeShipmentProvider } = await import("@ammari/commerce/shipping");
      const fake = createFakeShipmentProvider();
      fake.controls.adopt({ providerOrderId: shipment.providerOrderId!, referenceId: shipment.referenceId, waybillId: shipment.awb, courierCode: "jne", serviceCode: "reg", price: 12_000, providerStatus: "confirmed" });
      fake.controls.advance(shipment.providerOrderId!, "picked");

      const response = await pollCall();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ candidates: 1, read: 1, shipped: 1, changedOrderNos: [order.orderNo], budgetExhausted: false });
      expect(scheduleOrderEmails).toHaveBeenCalledWith([{ orderNo: order.orderNo }], "shipment poll");
    });
  });

  test("503 without a tracking provider (the stale pass still runs)", async () => {
    await inRollback(async () => {
      delete process.env.SHIPPING_ORDER_PROVIDER;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await pollCall();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "courier tracking not configured", notConfigured: true });
    });
  });
});
