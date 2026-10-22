import { randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabrics, orderItems, orders, products, productVariants, shipmentEvents, shipments, type ShipmentStatus } from "@ammari/db/schema";
import { ActionError } from "../errors";
import { ShipmentProviderError, type ProviderShipment, type ShipmentHistoryEntry } from "./shipment-provider";
import { canonicalBiteshipStatus, normalizeBiteshipStatus } from "./shipment-rules";
import {
  SHIPMENT_CHANGED_MESSAGE,
  applyShipmentSnapshot,
  claimShipmentRead,
  flagStaleShipments,
  pollShipments,
  refetchShipmentForWebhook,
  type ShipmentReader,
} from "./tracking";

// docs/plans/cart-checkout.md §15 Phase K, K3: applying courier reads (webhook re-fetch, poll,
// staff) to shipments and their orders, against the test database. Every snapshot is written by
// hand like a parsed Biteship answer; nothing reaches Biteship.

const T0 = new Date("2026-10-01T02:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function uniqueOrderNo(): string {
  return `ORD-209911-${randomInt(100_000, 999_999)}`;
}

function providerId(): string {
  return randomBytes(12).toString("hex");
}

function entry(status: string, at: Date, note = "Catatan kurir"): ShipmentHistoryEntry {
  return { providerStatus: canonicalBiteshipStatus(status) ?? status, status: normalizeBiteshipStatus(status), note, occurredAt: at };
}

interface Booked {
  orderId: string;
  orderNo: string;
  shipmentId: string;
  providerOrderId: string;
  referenceId: string;
  awb: string;
}

/** A paid web order in to_ship with a booked attempt (`pickup_requested`, waybill issued), as K2
 * leaves it after "Pesan kurir". */
async function bookedOrder(db: TestDatabase, options: { awb?: string; status?: ShipmentStatus; orderStatus?: "to_ship" | "shipped" | "cancelled"; trackingNumber?: string | null; quotedCost?: number } = {}): Promise<Booked> {
  const { variant } = await insertProductVariant(db);
  const orderNo = uniqueOrderNo();
  const order = await insertOrder(db, {
    ...checkoutOrderValues(),
    ...shippingQuoteValues(options.quotedCost ?? 12_000),
    orderNo,
    status: options.orderStatus ?? "to_ship",
    paymentStatus: "paid",
    paidAt: new Date(),
    subtotalAmount: 259_000,
    shippingAmount: 0,
    totalAmount: 259_000,
    ...(options.orderStatus === "shipped" ? { courier: "JNE", trackingNumber: options.trackingNumber ?? null, shippedAt: new Date() } : {}),
    ...(options.orderStatus === "cancelled" ? { cancelledAt: new Date(), cancelReason: "admin" as const } : {}),
  });
  await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 });
  const pid = providerId();
  const referenceId = `T-${orderNo}-K1`;
  const awb = options.awb ?? `WYB-${randomInt(100_000_000, 999_999_999)}`;
  const [row] = await db
    .insert(shipments)
    .values({
      orderId: order.id,
      attempt: 1,
      referenceId,
      provider: "biteship",
      providerOrderId: pid,
      courier: "jne",
      service: "reg",
      awb,
      costAmount: options.quotedCost ?? 12_000,
      status: options.status ?? "pickup_requested",
      providerStatus: "confirmed",
      bookedAt: T0,
      lastEventAt: T0,
    })
    .returning();
  return { orderId: order.id, orderNo, shipmentId: row!.id, providerOrderId: pid, referenceId, awb };
}

/** A parsed read of the booked attempt. */
function snapshot(booked: Booked, status: string | null, history: ShipmentHistoryEntry[], overrides: Partial<ProviderShipment> = {}): ProviderShipment {
  return {
    providerOrderId: booked.providerOrderId,
    referenceId: booked.referenceId,
    providerStatus: status,
    knownStatus: status ? canonicalBiteshipStatus(status) : null,
    status: status ? normalizeBiteshipStatus(status) : null,
    waybillId: booked.awb,
    trackingId: "track-1",
    routingCode: "BDO-01",
    courierCode: "jne",
    serviceCode: "reg",
    price: 12_000,
    trackingLink: null,
    driver: null,
    history,
    ...overrides,
  };
}

const POLL = { source: "poll" as const, actorStaffUserId: null, action: "track_shipment_poll" };

async function orderOf(db: TestDatabase, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

async function shipmentOf(db: TestDatabase, shipmentId: string) {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
  return row!;
}

async function eventsOf(db: TestDatabase, shipmentId: string) {
  return db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipmentId)).orderBy(shipmentEvents.occurredAt, shipmentEvents.providerStatus);
}

const PICKED = (booked: Booked) => snapshot(booked, "picked", [entry("confirmed", T0), entry("allocated", minutes(10)), entry("picked", minutes(60))]);

describe("applyShipmentSnapshot: status mapping", () => {
  test("picked up ships the order with the quoted courier and the waybill as resi, no staff actor, and stores the history", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), { ...POLL, source: "webhook", action: "track_shipment_webhook" });

      expect(result).toMatchObject({ applied: true, stale: false, eventsAdded: 3, orderTransitions: ["shipped"], flagsRaised: [] });
      expect(await orderOf(tx, booked.orderId)).toMatchObject({ status: "shipped", courier: "JNE Reguler", trackingNumber: booked.awb, needsAttention: [] });
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "picked_up", providerStatus: "picked", pickedUpAt: minutes(60), lastEventAt: minutes(60), routingCode: "BDO-01" });
      const events = await eventsOf(tx, booked.shipmentId);
      expect(events.map((event) => [event.providerStatus, event.normalizedStatus, event.source])).toEqual([
        ["confirmed", "pickup_requested", "webhook"],
        ["allocated", "pickup_requested", "webhook"],
        ["picked", "picked_up", "webhook"],
      ]);
      const transition = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, booked.orderId), eq(auditLog.action, "transition_status")));
      expect(transition).toHaveLength(1);
      expect(transition[0]!.actorStaffUserId).toBeNull();
    });
  });

  test("in transit without a picked entry (pickup missed) ships the order too", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "in_transit", [entry("in_transit", minutes(90))]), POLL);
      expect(result.orderTransitions).toEqual(["shipped"]);
      expect((await shipmentOf(tx, booked.shipmentId)).status).toBe("in_transit");
    });
  });

  test("delivered from to_ship passes through shipped to completed and stamps the courier's delivery time", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "delivered", [entry("picked", minutes(60)), entry("delivered", minutes(600))]), POLL);
      expect(result.orderTransitions).toEqual(["shipped", "completed"]);
      const order = await orderOf(tx, booked.orderId);
      expect(order).toMatchObject({ status: "completed", trackingNumber: booked.awb });
      expect(order.shippedAt).not.toBeNull();
      expect(order.completedAt).not.toBeNull();
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "delivered", deliveredAt: minutes(600) });
    });
  });

  test("delivered on an order staff already shipped by hand completes it and keeps their resi", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "shipped", trackingNumber: "MANUAL12345" });
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "delivered", [entry("delivered", minutes(600))]), POLL);
      expect(result.orderTransitions).toEqual(["completed"]);
      expect(await orderOf(tx, booked.orderId)).toMatchObject({ status: "completed", trackingNumber: "MANUAL12345" });
    });
  });

  test("waiting states change nothing on the order", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "picking_up", [entry("picking_up", minutes(30))]), POLL);
      expect(result).toMatchObject({ applied: true, orderTransitions: [], flagsRaised: [] });
      expect((await orderOf(tx, booked.orderId)).status).toBe("to_ship");
    });
  });

  test.each([
    ["on_hold", "problem"],
    ["rejected", "problem"],
    ["disposed", "problem"],
    ["return_in_transit", "returning"],
    ["returned", "returned"],
  ] as const)("%s flags delivery_problem and never returns the order by itself", async (status, state) => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "shipped", trackingNumber: undefined });
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, status, [entry(status, minutes(120))]), POLL);
      expect(result.flagsRaised).toEqual(["delivery_problem"]);
      expect((await shipmentOf(tx, booked.shipmentId)).status).toBe(state);
      expect(await orderOf(tx, booked.orderId)).toMatchObject({ status: "shipped", needsAttention: ["delivery_problem"] });
    });
  });

  test.each(["courier_not_found", "cancelled"])("%s we did not ask for ends the attempt, flags it, and the order can be booked again", async (status) => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, status, [entry(status, minutes(30))]), POLL);
      expect(result.flagsRaised).toEqual(["delivery_problem"]);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "cancelled" });
      expect((await orderOf(tx, booked.orderId)).status).toBe("to_ship");
      // A new live attempt is allowed (shipments_live_order_id_key only counts live ones).
      await tx.insert(shipments).values({ orderId: booked.orderId, attempt: 2, referenceId: `${booked.referenceId}-2`, provider: "biteship", courier: "jne", service: "reg" });
    });
  });

  test("a cancel we asked for is not flagged", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await tx.update(shipments).set({ cancelRequestedAt: new Date() }).where(eq(shipments.id, booked.shipmentId));
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "cancelled", [entry("cancelled", minutes(30))]), POLL);
      expect(result.flagsRaised).toEqual([]);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "cancelled", cancelRequestedAt: null });
    });
  });

  test("an undocumented status is stored raw and flagged, never applied, and never completes the order", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "shipped" });
      const odd = snapshot(booked, "teleported", [entry("teleported", minutes(200))]);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, odd, POLL);
      expect(result.flagsRaised).toEqual(["delivery_problem"]);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "pickup_requested", providerStatus: "teleported" });
      expect((await eventsOf(tx, booked.shipmentId)).map((event) => [event.providerStatus, event.normalizedStatus])).toEqual([["teleported", null]]);
      expect((await orderOf(tx, booked.orderId)).status).toBe("shipped");

      // The same read again raises nothing new.
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, booked.orderId));
      expect((await applyShipmentSnapshot(tx, booked.shipmentId, odd, POLL)).flagsRaised).toEqual([]);
    });
  });

  test("a parcel moving for a cancelled order is flagged, the order stays cancelled", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "cancelled" });
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), POLL);
      expect(result).toMatchObject({ orderTransitions: [], flagsRaised: ["delivery_problem"] });
      expect((await orderOf(tx, booked.orderId)).status).toBe("cancelled");
    });
  });
});

describe("applyShipmentSnapshot: flags raised on change only", () => {
  test("a problem flag staff cleared is not raised again by the same read; a new problem status raises it", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "shipped" });
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "on_hold", [entry("on_hold", minutes(100))]), POLL);
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, booked.orderId));
      expect((await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "on_hold", [entry("on_hold", minutes(100))]), POLL)).flagsRaised).toEqual([]);
      const rejected = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "rejected", [entry("on_hold", minutes(100)), entry("rejected", minutes(300))]), POLL);
      expect(rejected.flagsRaised).toEqual(["delivery_problem"]);
    });
  });

  test("a price more than Rp5.000 over the quote flags once, only when the price changes", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { quotedCost: 12_000 });
      const reweighed = snapshot(booked, "picked", [entry("picked", minutes(60))], { price: 17_001 });
      expect((await applyShipmentSnapshot(tx, booked.shipmentId, reweighed, POLL)).flagsRaised).toEqual(["shipping_cost_over_quote"]);
      expect((await shipmentOf(tx, booked.shipmentId)).costAmount).toBe(17_001);
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, booked.orderId));
      expect((await applyShipmentSnapshot(tx, booked.shipmentId, reweighed, POLL)).flagsRaised).toEqual([]);
      // Exactly Rp5.000 over is not flagged.
      const fine = await bookedOrder(tx, { quotedCost: 12_000 });
      expect((await applyShipmentSnapshot(tx, fine.shipmentId, snapshot(fine, "picked", [entry("picked", minutes(60))], { price: 17_000 }), POLL)).flagsRaised).toEqual([]);
    });
  });
});

describe("applyShipmentSnapshot: waybill", () => {
  test("a new waybill replaces a resi that came from the booking, on the shipment and the order", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), POLL);
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "in_transit", [entry("picked", minutes(60)), entry("in_transit", minutes(120))], { waybillId: "JNE0099887766" }), POLL);
      expect(result.flagsRaised).toEqual([]);
      expect((await shipmentOf(tx, booked.shipmentId)).awb).toBe("JNE0099887766");
      expect((await orderOf(tx, booked.orderId)).trackingNumber).toBe("JNE0099887766");
    });
  });

  test("a resi staff typed that differs from a new waybill is kept and flagged", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { orderStatus: "shipped", trackingNumber: "MANUAL12345" });
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "in_transit", [entry("in_transit", minutes(120))], { waybillId: "JNE0099887766" }), POLL);
      expect(result.flagsRaised).toEqual(["tracking_number_mismatch"]);
      expect((await orderOf(tx, booked.orderId)).trackingNumber).toBe("MANUAL12345");
    });
  });

  test("a waybill that fails the resi rule never ships the order; flagged once, shipped once a good one arrives", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx, { awb: "AB" });
      const bad = snapshot(booked, "picked", [entry("picked", minutes(60))], { waybillId: "AB" });
      expect(await applyShipmentSnapshot(tx, booked.shipmentId, bad, POLL)).toMatchObject({ orderTransitions: [], flagsRaised: ["delivery_problem"] });
      expect((await orderOf(tx, booked.orderId)).status).toBe("to_ship");
      expect((await applyShipmentSnapshot(tx, booked.shipmentId, bad, POLL)).flagsRaised).toEqual([]);
      const good = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "picked", [entry("picked", minutes(60))], { waybillId: "JNE0099887766" }), POLL);
      expect(good.orderTransitions).toEqual(["shipped"]);
      expect((await orderOf(tx, booked.orderId)).trackingNumber).toBe("JNE0099887766");
    });
  });
});

describe("applyShipmentSnapshot: replay, out of order, ended attempts", () => {
  test("a replayed read adds no event, no transition and no audit row", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), POLL);
      const auditsBefore = await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, booked.orderId));
      const replay = await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), POLL);
      expect(replay).toMatchObject({ applied: true, eventsAdded: 0, orderTransitions: [], flagsRaised: [] });
      expect(await eventsOf(tx, booked.shipmentId)).toHaveLength(3);
      expect(await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, booked.orderId))).toHaveLength(auditsBefore.length);
    });
  });

  test("a read older than the stored one (out of order) only adds its events", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "delivered", [entry("picked", minutes(60)), entry("delivered", minutes(600))]), POLL);
      const late = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "in_transit", [entry("picked", minutes(60)), entry("in_transit", minutes(300))], { price: 99_000 }), {
        ...POLL,
        source: "webhook",
      });
      expect(late).toMatchObject({ applied: false, stale: true, eventsAdded: 1 });
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "delivered", costAmount: 12_000, lastEventAt: minutes(600) });
      expect((await orderOf(tx, booked.orderId)).status).toBe("completed");
      expect((await eventsOf(tx, booked.shipmentId)).map((event) => event.providerStatus)).toEqual(["picked", "in_transit", "delivered"]);
    });
  });

  test("without history, a read never moves the status back, and delivered is final", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "in_transit", []), POLL);
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "picked", []), POLL);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "in_transit", providerStatus: "in_transit" });
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "delivered", []), POLL);
      const after = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "on_hold", []), POLL);
      expect(after.flagsRaised).toEqual([]);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ status: "delivered", providerStatus: "delivered" });
    });
  });

  test("an ended attempt is never revived by a late read", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(shipments.id, booked.shipmentId));
      const result = await applyShipmentSnapshot(tx, booked.shipmentId, PICKED(booked), POLL);
      expect(result).toMatchObject({ applied: false, eventsAdded: 0 });
      expect((await shipmentOf(tx, booked.shipmentId)).status).toBe("cancelled");
      expect((await orderOf(tx, booked.orderId)).status).toBe("to_ship");
    });
  });

  test("a courier time in the future is clamped, so later reads still apply", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const future = new Date(Date.now() + 365 * 24 * 60 * 60_000);
      await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "picked", [entry("picked", future)]), POLL);
      expect((await shipmentOf(tx, booked.shipmentId)).lastEventAt!.getTime()).toBeLessThan(Date.now() + 10 * 60_000);
      const later = await applyShipmentSnapshot(tx, booked.shipmentId, snapshot(booked, "delivered", [entry("picked", future), entry("delivered", new Date(Date.now() + 60_000))]), POLL);
      expect(later).toMatchObject({ stale: false, orderTransitions: ["completed"] });
    });
  });

  test("a read for another provider order or reference is refused and writes nothing", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      for (const overrides of [{ providerOrderId: providerId() }, { referenceId: "T-ORD-OTHER-K1" }]) {
        const error = await applyShipmentSnapshot(tx, booked.shipmentId, { ...PICKED(booked), ...overrides }, POLL).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(ActionError);
        expect((error as ActionError).message).toBe(SHIPMENT_CHANGED_MESSAGE);
      }
      expect(await eventsOf(tx, booked.shipmentId)).toHaveLength(0);
      expect((await orderOf(tx, booked.orderId)).status).toBe("to_ship");
    });
  });
});

/** A reader that answers from a map (or throws what it is given), counting calls. */
function reader(answers: Map<string, ProviderShipment | Error>): ShipmentReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async getShipment(id: string) {
      calls.push(id);
      const answer = answers.get(id);
      if (!answer) throw new ShipmentProviderError("not_found", "no such order", { status: 404 });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("reads: claim, debounce, webhook re-fetch", () => {
  test("a read is claimed once per 2 minutes; a debounced webhook asks the next poll to read it", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      const first = await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      expect(first.outcome).toBe("applied");
      expect(first.applied?.orderTransitions).toEqual(["shipped"]);
      const second = await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      expect(second.outcome).toBe("debounced");
      expect(r.calls).toHaveLength(1);
      expect((await shipmentOf(tx, booked.shipmentId)).refetchRequestedAt).not.toBeNull();
      // Two minutes later it may be read again, which clears the request.
      await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, booked.shipmentId));
      expect((await refetchShipmentForWebhook(tx, r, booked.shipmentId)).outcome).toBe("applied");
      expect((await shipmentOf(tx, booked.shipmentId)).refetchRequestedAt).toBeNull();
    });
  });

  // The dev incident of 2026-10-22: Biteship sent one post per status step, 13 seconds apart. The
  // first read saw `allocated` (no order change) and the post that carried `picked` came inside its
  // 2-minute window, so it only asked the 3-hourly poll to read later.
  test("a post inside another read's window waits for the window, then reads: the later step ships the order", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const answers = new Map([[booked.providerOrderId, snapshot(booked, "allocated", [entry("confirmed", T0), entry("allocated", minutes(10))])]]);
      const r = reader(answers);
      const first = await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      expect(first).toMatchObject({ outcome: "applied", fetch: "fetched" });
      expect(first.applied?.orderTransitions).toEqual([]);

      // Biteship moves on; its next post arrives seconds later.
      answers.set(booked.providerOrderId, PICKED(booked));
      const waits: number[] = [];
      const second = await refetchShipmentForWebhook(tx, r, booked.shipmentId, {
        waitForReadWindow: async (ms) => {
          waits.push(ms);
          // The window passes (the test transaction's now() is frozen, so the read is backdated).
          await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, booked.shipmentId));
          return true;
        },
      });
      expect(second).toMatchObject({ outcome: "applied", fetch: "deferred" });
      expect(second.applied?.orderTransitions).toEqual(["shipped"]);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(100_000);
      expect(waits[0]).toBeLessThanOrEqual(121_000);
      expect(r.calls).toHaveLength(2);
      expect(await shipmentOf(tx, booked.shipmentId)).toMatchObject({ refetchRequestedAt: null, providerStatus: "picked" });
      expect((await orderOf(tx, booked.orderId)).status).toBe("shipped");
    });
  });

  test("a waiting post that another read served meanwhile does not read again", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      const waited = await refetchShipmentForWebhook(tx, r, booked.shipmentId, {
        waitForReadWindow: async () => {
          // Another waiting post's read claims first, after this post arrived.
          await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, booked.shipmentId));
          expect(await claimShipmentRead(tx, booked.shipmentId)).not.toBeNull();
          return true;
        },
      });
      expect(waited).toEqual({ outcome: "debounced", applied: null, fetch: "debounced" });
      expect(r.calls).toHaveLength(1);
    });
  });

  test("a shipment that ends while a post waits is reported closed, not read", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      const waited = await refetchShipmentForWebhook(tx, r, booked.shipmentId, {
        waitForReadWindow: async () => {
          await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date(), lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, booked.shipmentId));
          return true;
        },
      });
      expect(waited).toEqual({ outcome: "closed", applied: null, fetch: "none" });
      expect(r.calls).toHaveLength(1);
    });
  });

  test("the wait is the rest of the window by the database clock, plus a second", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      // Read 118 s ago (the transaction's now() is fixed): 2 s of the window left.
      await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '118 seconds'` }).where(eq(shipments.id, booked.shipmentId));
      const waits: number[] = [];
      await refetchShipmentForWebhook(tx, r, booked.shipmentId, {
        waitForReadWindow: async (ms) => {
          waits.push(ms);
          return false;
        },
      });
      expect(waits).toEqual([3_000]);
    });
  });

  test("a post told not to wait stays debounced for the poll", async () => {
    await withRollback(async (tx) => {
      const booked = await bookedOrder(tx);
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      await refetchShipmentForWebhook(tx, r, booked.shipmentId);
      const seen: string[] = [];
      const skipped = await refetchShipmentForWebhook(tx, r, booked.shipmentId, {
        waitForReadWindow: async (_ms, shipmentId) => {
          seen.push(shipmentId);
          return false;
        },
      });
      expect(skipped).toEqual({ outcome: "debounced", applied: null, fetch: "debounced" });
      expect(seen).toEqual([booked.shipmentId]);
      expect((await shipmentOf(tx, booked.shipmentId)).refetchRequestedAt).not.toBeNull();
      expect(r.calls).toHaveLength(1);
    });
  });

  test("ended, final and unbooked shipments are never read", async () => {
    await withRollback(async (tx) => {
      const delivered = await bookedOrder(tx, { status: "delivered" });
      await tx.update(shipments).set({ providerStatus: "delivered", deliveredAt: new Date() }).where(eq(shipments.id, delivered.shipmentId));
      const rejected = await bookedOrder(tx, { status: "problem" });
      await tx.update(shipments).set({ providerStatus: "rejected" }).where(eq(shipments.id, rejected.shipmentId));
      const r = reader(new Map());
      for (const id of [delivered.shipmentId, rejected.shipmentId]) {
        expect(await claimShipmentRead(tx, id)).toBeNull();
        expect((await refetchShipmentForWebhook(tx, r, id)).outcome).toBe("closed");
      }
      expect(r.calls).toHaveLength(0);
    });
  });

  test("a failed read is kept visible: unavailable and budget ask for a re-read, not found records why", async () => {
    await withRollback(async (tx) => {
      const unavailable = await bookedOrder(tx);
      const budget = await bookedOrder(tx);
      const gone = await bookedOrder(tx);
      const r = reader(
        new Map<string, ProviderShipment | Error>([
          [unavailable.providerOrderId, new ShipmentProviderError("unavailable", "timed out")],
          [budget.providerOrderId, new ShipmentProviderError("budget_exhausted", "used up")],
        ]),
      );
      expect((await refetchShipmentForWebhook(tx, r, unavailable.shipmentId)).outcome).toBe("unavailable");
      expect((await refetchShipmentForWebhook(tx, r, budget.shipmentId)).outcome).toBe("budget_exhausted");
      expect((await refetchShipmentForWebhook(tx, r, gone.shipmentId)).outcome).toBe("failed");
      expect(await shipmentOf(tx, unavailable.shipmentId)).toMatchObject({ lastError: "read:unavailable", refetchRequestedAt: expect.any(Date) });
      expect(await shipmentOf(tx, budget.shipmentId)).toMatchObject({ lastError: "read:budget_exhausted", refetchRequestedAt: expect.any(Date) });
      expect(await shipmentOf(tx, gone.shipmentId)).toMatchObject({ lastError: "read:not_found", refetchRequestedAt: null, status: "pickup_requested" });
      // A read that keeps failing for good flags the order once (not on every later failure).
      expect((await orderOf(tx, gone.orderId)).needsAttention).toEqual(["delivery_problem"]);
      expect((await orderOf(tx, unavailable.orderId)).needsAttention).toEqual([]);
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, gone.orderId));
      await tx.update(shipments).set({ lastPolledAt: null }).where(eq(shipments.id, gone.shipmentId));
      expect((await refetchShipmentForWebhook(tx, r, gone.shipmentId)).outcome).toBe("failed");
      expect((await orderOf(tx, gone.orderId)).needsAttention).toEqual([]);
      // A later good read clears the error.
      await tx.update(shipments).set({ lastPolledAt: null }).where(eq(shipments.id, unavailable.shipmentId));
      await refetchShipmentForWebhook(tx, reader(new Map([[unavailable.providerOrderId, PICKED(unavailable)]])), unavailable.shipmentId);
      expect((await shipmentOf(tx, unavailable.shipmentId)).lastError).toBeNull();
    });
  });
});

describe("pollShipments", () => {
  test("a mismatched read flags the order once; a database error on one shipment never ends the run", async () => {
    await withRollback(async (tx) => {
      await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date() }).where(sql`status not in ('cancelled', 'failed')`);
      const mismatched = await bookedOrder(tx);
      const fine = await bookedOrder(tx);
      const r = reader(
        new Map([
          [mismatched.providerOrderId, { ...PICKED(mismatched), referenceId: "T-ORD-OTHER-K1" }],
          [fine.providerOrderId, PICKED(fine)],
        ]),
      );
      const summary = await pollShipments(tx, r);
      expect(summary.outcomes).toEqual({ failed: 1, applied: 1 });
      expect(summary.changedOrderNos).toEqual([fine.orderNo]);
      expect(await shipmentOf(tx, mismatched.shipmentId)).toMatchObject({ lastError: "read:mismatch" });
      expect((await orderOf(tx, mismatched.orderId)).needsAttention).toContain("delivery_problem");
      // A permanently failing shipment waiting for pickup is no longer read every run.
      await tx.update(shipments).set({ lastPolledAt: sql`now() - interval '3 hours'` }).where(eq(shipments.id, mismatched.shipmentId));
      const next = await pollShipments(tx, r);
      expect(next.candidates).toBe(0);
    });
  });

  test("reads re-fetch requests, then every shipment waiting for pickup, then quiet ones past 6 hours; never fresh or final ones", async () => {
    await withRollback(async (tx) => {
      // Only this test's shipments are readable: park every other open one (rolled back afterwards).
      await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date() }).where(sql`status not in ('cancelled', 'failed')`);
      const waiting = await bookedOrder(tx); // pickup_requested: always read
      const quiet = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ lastEventAt: sql`now() - interval '7 hours'`, lastPolledAt: sql`now() - interval '7 hours'` }).where(eq(shipments.id, quiet.shipmentId));
      const fresh = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ lastEventAt: sql`now() - interval '1 hour'`, lastPolledAt: sql`now() - interval '7 hours'` }).where(eq(shipments.id, fresh.shipmentId));
      const recentlyPolled = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ lastEventAt: sql`now() - interval '7 hours'`, lastPolledAt: sql`now() - interval '1 hour'` }).where(eq(shipments.id, recentlyPolled.shipmentId));
      const asked = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ lastEventAt: sql`now() - interval '1 hour'`, lastPolledAt: sql`now() - interval '1 hour'`, refetchRequestedAt: sql`now()` }).where(eq(shipments.id, asked.shipmentId));
      const done = await bookedOrder(tx, { status: "delivered" });
      await tx.update(shipments).set({ providerStatus: "delivered", deliveredAt: new Date(), lastPolledAt: null }).where(eq(shipments.id, done.shipmentId));

      const r = reader(
        new Map([
          [waiting.providerOrderId, PICKED(waiting)],
          [quiet.providerOrderId, snapshot(quiet, "delivered", [entry("delivered", new Date())])],
          [asked.providerOrderId, snapshot(asked, "in_transit", [entry("in_transit", new Date())])],
        ]),
      );
      const summary = await pollShipments(tx, r);
      expect(r.calls).toEqual([asked.providerOrderId, waiting.providerOrderId, quiet.providerOrderId]);
      expect(summary).toMatchObject({ candidates: 3, read: 3, shipped: 1, completed: 1, budgetExhausted: false, truncated: false, notConfigured: false });
      expect(summary.outcomes).toEqual({ applied: 3 });
      expect(new Set(summary.changedOrderNos)).toEqual(new Set([waiting.orderNo, quiet.orderNo]));
      expect(await shipmentOf(tx, asked.shipmentId)).toMatchObject({ refetchRequestedAt: null });
    });
  });

  test("stops at the daily budget and marks the shipments it did not reach", async () => {
    await withRollback(async (tx) => {
      await tx.update(shipments).set({ status: "cancelled", cancelledAt: new Date() }).where(sql`status not in ('cancelled', 'failed')`);
      const first = await bookedOrder(tx);
      const second = await bookedOrder(tx);
      const third = await bookedOrder(tx);
      const r = reader(new Map<string, ProviderShipment | Error>([[first.providerOrderId, PICKED(first)]]));
      // The second read hits the budget whichever order they come in.
      const budgetError = new ShipmentProviderError("budget_exhausted", "used up");
      let reads = 0;
      const limited: ShipmentReader & { calls: string[] } = {
        name: "fake",
        calls: r.calls,
        async getShipment(id) {
          reads += 1;
          if (reads >= 2) throw budgetError;
          return r.getShipment(id);
        },
      };
      const summary = await pollShipments(tx, limited);
      expect(summary.budgetExhausted).toBe(true);
      expect(summary.read).toBe(2);
      const rows = await tx.select().from(shipments).where(inArray(shipments.id, [first.shipmentId, second.shipmentId, third.shipmentId]));
      expect(rows.filter((row) => row.lastError === "read:budget_exhausted")).toHaveLength(2);
      expect(rows.filter((row) => row.refetchRequestedAt !== null)).toHaveLength(2);
    });
  });

  test("without a provider only the stale pass runs", async () => {
    await withRollback(async (tx) => {
      const summary = await pollShipments(tx, null);
      expect(summary).toMatchObject({ notConfigured: true, read: 0, candidates: 0 });
    });
  });
});

describe("flagStaleShipments", () => {
  test("no pickup 2 days after booking, or no event for 5 days, flags tracking_stale once per quiet spell", async () => {
    await withRollback(async (tx) => {
      const noPickup = await bookedOrder(tx);
      await tx.update(shipments).set({ bookedAt: sql`now() - interval '49 hours'`, lastEventAt: sql`now() - interval '49 hours'` }).where(eq(shipments.id, noPickup.shipmentId));
      const quiet = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ bookedAt: sql`now() - interval '10 days'`, lastEventAt: sql`now() - interval '121 hours'` }).where(eq(shipments.id, quiet.shipmentId));
      const moving = await bookedOrder(tx, { status: "in_transit", orderStatus: "shipped" });
      await tx.update(shipments).set({ bookedAt: sql`now() - interval '10 days'`, lastEventAt: sql`now() - interval '1 day'` }).where(eq(shipments.id, moving.shipmentId));

      const flagged = await flagStaleShipments(tx);
      expect(flagged).toEqual(expect.arrayContaining([noPickup.orderNo, quiet.orderNo]));
      expect(flagged).not.toContain(moving.orderNo);
      expect((await orderOf(tx, quiet.orderId)).needsAttention).toEqual(["tracking_stale"]);

      // Staff clear it; the same quiet spell does not raise it again.
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, quiet.orderId));
      expect(await flagStaleShipments(tx)).not.toContain(quiet.orderNo);
      // A new event, then another 5 quiet days: raised again.
      await tx.update(shipments).set({ lastEventAt: sql`now() - interval '6 days'`, staleFlaggedAt: sql`now() - interval '7 days'` }).where(eq(shipments.id, quiet.shipmentId));
      expect(await flagStaleShipments(tx)).toContain(quiet.orderNo);
    });
  });
});

describe("races (committed transactions)", () => {
  test("a webhook re-fetch, a poll and a staff read of the same pickup at once ship the order once", async () => {
    const booked = await bookedOrder(testDb);
    try {
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      const [webhookA, webhookB, staff, poll] = await Promise.all([
        refetchShipmentForWebhook(testDb, r, booked.shipmentId),
        refetchShipmentForWebhook(testDb, r, booked.shipmentId),
        applyShipmentSnapshot(testDb, booked.shipmentId, PICKED(booked), { source: "staff", actorStaffUserId: null, action: "refresh_shipment" }),
        applyShipmentSnapshot(testDb, booked.shipmentId, PICKED(booked), POLL),
      ]);
      // One webhook read claimed it, the other was debounced.
      expect([webhookA.outcome, webhookB.outcome].sort()).toEqual(["applied", "debounced"]);
      expect(r.calls).toHaveLength(1);
      const shippedBy = [...(webhookA.applied?.orderTransitions ?? []), ...(webhookB.applied?.orderTransitions ?? []), ...staff.orderTransitions, ...poll.orderTransitions];
      expect(shippedBy).toEqual(["shipped"]);
      expect(await eventsOf(testDb, booked.shipmentId)).toHaveLength(3);
      const transitions = await testDb.select().from(auditLog).where(and(eq(auditLog.entityId, booked.orderId), eq(auditLog.action, "transition_status")));
      expect(transitions).toHaveLength(1);
      expect((await orderOf(testDb, booked.orderId)).status).toBe("shipped");
    } finally {
      await cleanUp(booked);
    }
  });
});

describe("races: posts waiting for the read window (committed transactions)", () => {
  test("two posts that waited for the same window read once between them", async () => {
    const booked = await bookedOrder(testDb);
    try {
      const r = reader(new Map([[booked.providerOrderId, PICKED(booked)]]));
      expect((await refetchShipmentForWebhook(testDb, r, booked.shipmentId)).outcome).toBe("applied");
      // Both wake when the window ends (backdated here, once) and claim at once.
      let ended: Promise<unknown> | null = null;
      const windowEnds = () => (ended ??= testDb.update(shipments).set({ lastPolledAt: sql`now() - interval '121 seconds'` }).where(eq(shipments.id, booked.shipmentId)).then(() => true)) as Promise<boolean>;
      const [a, b] = await Promise.all([
        refetchShipmentForWebhook(testDb, r, booked.shipmentId, { waitForReadWindow: windowEnds }),
        refetchShipmentForWebhook(testDb, r, booked.shipmentId, { waitForReadWindow: windowEnds }),
      ]);
      expect([a.fetch, b.fetch].sort()).toEqual(["debounced", "deferred"]);
      expect(r.calls).toHaveLength(2);
    } finally {
      await cleanUp(booked);
    }
  });
});

async function cleanUp(booked: Booked): Promise<void> {
  const [item] = await testDb.select({ sku: orderItems.sku }).from(orderItems).where(eq(orderItems.orderId, booked.orderId));
  await testDb.delete(shipmentEvents).where(eq(shipmentEvents.shipmentId, booked.shipmentId));
  await testDb.delete(shipments).where(eq(shipments.orderId, booked.orderId));
  await testDb.delete(auditLog).where(eq(auditLog.entityId, booked.orderId));
  await testDb.delete(orderItems).where(eq(orderItems.orderId, booked.orderId));
  await testDb.delete(orders).where(eq(orders.id, booked.orderId));
  if (!item) return;
  const [variant] = await testDb.select({ productId: productVariants.productId, colorId: productVariants.fabricColorId, fabricId: productVariants.fabricId }).from(productVariants).where(eq(productVariants.sku, item.sku));
  await testDb.delete(productVariants).where(eq(productVariants.sku, item.sku));
  if (!variant) return;
  await testDb.delete(products).where(eq(products.id, variant.productId));
  await testDb.delete(fabricColors).where(eq(fabricColors.id, variant.colorId));
  await testDb.delete(fabrics).where(eq(fabrics.id, variant.fabricId));
}
