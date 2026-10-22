import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderItems, orders, shipmentEvents, shipments, shippingWebhookEvents } from "@ammari/db/schema";
import { BITESHIP_ORDER_PICKED } from "./biteship-fixtures";
import { createBiteshipOrdersClient } from "./biteship-orders";
import type { ShipmentReader } from "./tracking";
import { parseShippingWebhookBody, processShippingWebhook, recordShippingWebhook } from "./webhook";

// docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling" (K3): the courier webhook is logged
// and only re-fetches; nothing in its body is acted on. The re-fetch runs the real Biteship order
// client over a stubbed fetch answering the hand-written fixture (nothing reaches Biteship).

/** Biteship's `order.status` webhook body, shaped like the webhook overview page's example (only
 * `event` and `order_id` are ever read; the values are fictional, and deliberately claim a status
 * the re-fetch does not confirm). */
const ORDER_STATUS_WEBHOOK = {
  event: "order.status",
  courier_tracking_id: "6051861741a37414e6637fab",
  courier_waybill_id: "0123082100003094",
  courier_company: "jne",
  courier_type: "reg",
  order_id: BITESHIP_ORDER_PICKED.id,
  status: "delivered",
  order_price: 1,
  updated_at: "2026-12-02T14:05:00+07:00",
};

/** A reader over the real client: every GET answers the picked fixture. */
function fixtureReader(): ShipmentReader & { reads: () => number } {
  let reads = 0;
  const client = createBiteshipOrdersClient({
    apiKey: "fake-key-for-tests",
    baseUrl: "https://api.biteship.com",
    fetch: async () => {
      reads += 1;
      return new Response(JSON.stringify(BITESHIP_ORDER_PICKED), { status: 200 });
    },
  });
  return { name: client.name, getShipment: (id) => client.getShipment(id), reads: () => reads };
}

async function bookedFixtureOrder(db: TestDatabase) {
  const { variant } = await insertProductVariant(db);
  const order = await insertOrder(db, {
    ...checkoutOrderValues(),
    ...shippingQuoteValues(34_000),
    orderNo: `ORD-209910-${randomInt(100_000, 999_999)}`,
    status: "to_ship",
    paymentStatus: "paid",
    paidAt: new Date(),
    subtotalAmount: 259_000,
    shippingAmount: 14_000,
    totalAmount: 273_000,
  });
  await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 });
  const [shipment] = await db
    .insert(shipments)
    .values({
      orderId: order.id,
      attempt: 1,
      referenceId: BITESHIP_ORDER_PICKED.reference_id,
      provider: "biteship",
      providerOrderId: BITESHIP_ORDER_PICKED.id,
      courier: "jne",
      service: "reg",
      awb: BITESHIP_ORDER_PICKED.courier.waybill_id,
      costAmount: 34_000,
      status: "pickup_requested",
      providerStatus: "confirmed",
      bookedAt: new Date("2026-12-02T03:00:00Z"),
    })
    .returning();
  return { order, shipment: shipment! };
}

async function logged(db: TestDatabase, body: string) {
  const parsed = parseShippingWebhookBody(body);
  const row = await recordShippingWebhook(db, parsed, Buffer.byteLength(body));
  return { id: row.id, providerOrderId: parsed.providerOrderId };
}

describe("parseShippingWebhookBody", () => {
  test("reads the event and the Biteship order id, keeps the payload as sent", () => {
    const parsed = parseShippingWebhookBody(JSON.stringify(ORDER_STATUS_WEBHOOK));
    expect(parsed).toMatchObject({ event: "order.status", providerOrderId: BITESHIP_ORDER_PICKED.id, rawText: null });
    expect(parsed.payload).toEqual(ORDER_STATUS_WEBHOOK);
  });

  test("an empty, odd or hostile body is kept but names nothing", () => {
    expect(parseShippingWebhookBody("")).toEqual({ payload: null, rawText: null, event: null, providerOrderId: null });
    expect(parseShippingWebhookBody("   ")).toEqual({ payload: null, rawText: null, event: null, providerOrderId: null });
    expect(parseShippingWebhookBody("not json")).toEqual({ payload: null, rawText: "not json", event: null, providerOrderId: null });
    expect(parseShippingWebhookBody("x".repeat(10_000)).rawText).toHaveLength(4_000);
    expect(parseShippingWebhookBody("[1,2]")).toMatchObject({ payload: [1, 2], event: null, providerOrderId: null });
    expect(parseShippingWebhookBody(JSON.stringify({ order_id: "../../v1/orders", event: 5 }))).toMatchObject({ providerOrderId: null, event: null });
    expect(parseShippingWebhookBody(JSON.stringify({ order_id: 12345 })).providerOrderId).toBeNull();
    // NUL characters would make Postgres refuse the row: dropped.
    expect(parseShippingWebhookBody('{"order_id":"abc\\u0000","event":"x"}'.replace("\\u0000", "\u0000")).providerOrderId).toBe("abc");
  });
});

describe("recordShippingWebhook", () => {
  test("a payload jsonb refuses (an escaped NUL) is kept as text, never lost", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const body = '{"event":"order.status","order_id":"abcdefabcdefabcdefabcdef","note":"x\\u0000y"}';
      const event = await logged(tx, body);
      expect(event.providerOrderId).toBe("abcdefabcdefabcdefabcdef");
      const [row] = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.id, event.id));
      expect(row).toMatchObject({ payload: null, event: "order.status" });
      expect(row!.rawText).toContain("abcdefabcdefabcdefabcdef");
      expect(row!.rawText).not.toContain("\\u0000");
    });
  });
});

describe("processShippingWebhook", () => {
  test("re-fetches the shipment and applies only Biteship's answer, never the body's claims", async () => {
    await withRollback(async (tx) => {
      const { order, shipment } = await bookedFixtureOrder(tx);
      const reader = fixtureReader();
      const event = await logged(tx, JSON.stringify(ORDER_STATUS_WEBHOOK));
      const outcome = await processShippingWebhook(tx, reader, event);

      // The body said delivered for Rp1; Biteship says picked for Rp41.000.
      expect(outcome).toEqual({ result: "applied", orderNo: order.orderNo, orderTransitions: ["shipped"] });
      const [stored] = await tx.select().from(shipments).where(eq(shipments.id, shipment.id));
      expect(stored).toMatchObject({ status: "picked_up", providerStatus: "picked", costAmount: 41_000, routingCode: "BDO-JKT 12250" });
      const [updated] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(updated).toMatchObject({ status: "shipped", trackingNumber: "0123082100003094", needsAttention: ["shipping_cost_over_quote"] });
      expect(await tx.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipment.id))).toHaveLength(3);
      const [row] = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.id, event.id));
      expect(row).toMatchObject({ event: "order.status", providerOrderId: BITESHIP_ORDER_PICKED.id, shipmentId: shipment.id, result: "applied", payload: ORDER_STATUS_WEBHOOK });
      expect(row!.processedAt).not.toBeNull();
    });
  });

  test("a replayed post within 2 minutes is logged and debounced: no second read, nothing applied twice", async () => {
    await withRollback(async (tx) => {
      const { shipment } = await bookedFixtureOrder(tx);
      const reader = fixtureReader();
      const body = JSON.stringify(ORDER_STATUS_WEBHOOK);
      await processShippingWebhook(tx, reader, await logged(tx, body));
      const replay = await logged(tx, body);
      expect(await processShippingWebhook(tx, reader, replay)).toEqual({ result: "debounced", orderNo: null, orderTransitions: [] });
      expect(reader.reads()).toBe(1);
      expect(await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.shipmentId, shipment.id))).toHaveLength(2);
      const [stored] = await tx.select().from(shipments).where(eq(shipments.id, shipment.id));
      expect(stored!.refetchRequestedAt).not.toBeNull();
    });
  });

  test("an order that is not ours, or no order id at all, is logged and nothing is fetched", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const reader = fixtureReader();
      const unknown = await logged(tx, JSON.stringify({ ...ORDER_STATUS_WEBHOOK, order_id: "ffffffffffffffffffffffff" }));
      expect((await processShippingWebhook(tx, reader, unknown)).result).toBe("unknown_order");
      const empty = await logged(tx, "");
      expect((await processShippingWebhook(tx, reader, empty)).result).toBe("no_order_id");
      expect(reader.reads()).toBe(0);
      const rows = await tx.select().from(shippingWebhookEvents).where(eq(shippingWebhookEvents.id, empty.id));
      expect(rows[0]).toMatchObject({ payload: null, rawText: null, bodyBytes: 0, result: "no_order_id" });
    });
  });

  test("without a configured reader the read is handed to the poller", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { shipment } = await bookedFixtureOrder(tx);
      const event = await logged(tx, JSON.stringify(ORDER_STATUS_WEBHOOK));
      expect((await processShippingWebhook(tx, null, event)).result).toBe("unavailable");
      const [stored] = await tx.select().from(shipments).where(eq(shipments.id, shipment.id));
      expect(stored).toMatchObject({ status: "pickup_requested" });
      expect(stored!.refetchRequestedAt).not.toBeNull();
    });
  });
});
