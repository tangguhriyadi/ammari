import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { auditLog, fabricColors, fabrics, orderItems, orders, products, productVariants, shipmentEvents, shipments, staffUsers } from "@ammari/db/schema";
import { ActionError } from "../errors";
import { transitionOrderStatus, updateShipmentDetails } from "../orders/lifecycle";
import { STAFF_CANCEL_MESSAGES, cancelCheckoutOrderByStaff } from "../payments/staff";
import { SHIPMENT_MESSAGES, bookShipment, cancelShipment, recheckBooking } from "./bookings";
import { createFakeShipmentProvider, createFakeShipmentStore, type FakeShipmentStore } from "./fake-shipments";
import { FAKE_SHIPMENT_ORIGIN, type ShipmentRuntime } from "./shipment-config";
import { ShipmentProviderError, type CreateShipmentInput, type ProviderShipment, type ShipmentProvider } from "./shipment-provider";

// docs/plans/cart-checkout.md §15 Phase K, K2: booking, re-checking and cancelling a courier for a
// paid web order, against the test database and the in-memory fake (nothing reaches Biteship).

const MURAH = "E2EMURAH40111"; // the fake quotes jne/reg at Rp12.000 here
const GANGGUAN = "E2EGANGGUAN40333"; // books, then loses the answer once

interface Harness {
  runtime: ShipmentRuntime;
  fake: ReturnType<typeof createFakeShipmentProvider>;
  store: FakeShipmentStore;
  calls: { create: CreateShipmentInput[]; get: string[]; cancel: string[] };
  /** Replace a call's behaviour once (then the fake answers again). */
  next: { create?: () => Promise<ProviderShipment>; cancel?: () => Promise<never> };
}

function harness(): Harness {
  const store = createFakeShipmentStore();
  const fake = createFakeShipmentProvider({ store });
  const calls: Harness["calls"] = { create: [], get: [], cancel: [] };
  const next: Harness["next"] = {};
  const provider: ShipmentProvider = {
    name: "fake",
    async createShipment(input) {
      calls.create.push(input);
      const override = next.create;
      next.create = undefined;
      return override ? override() : fake.createShipment(input);
    },
    async getShipment(id) {
      calls.get.push(id);
      return fake.getShipment(id);
    },
    async cancelShipment(id, input) {
      calls.cancel.push(id);
      const override = next.cancel;
      next.cancel = undefined;
      return override ? override() : fake.cancelShipment(id, input);
    },
  };
  return { runtime: { provider, origin: FAKE_SHIPMENT_ORIGIN, referencePrefix: "T-" }, fake, store, calls, next };
}

function uniqueOrderNo(): string {
  return `ORD-209912-${randomInt(100_000, 999_999)}`;
}

const SNAPSHOT = {
  version: 2,
  recipientName: "Rina Uji",
  phone: "+6281200000002",
  addressLine: "Jalan Uji No. 2, RT 01/RW 02, Kelurahan Uji",
  notes: "Pagar hijau",
  shippingAreaId: "00000000-0000-0000-0000-000000000000",
  providerAreaId: MURAH,
  province: "Jawa Barat",
  city: "Kota Bandung",
  district: "Kecamatan E2E Murah",
  subdistrict: null,
  postalCode: "40111",
  // Never sent to the courier.
  email: "pembeli@example.com",
};

async function paidOrder(db: TestDatabase, options: { destination?: string; quotedCost?: number; status?: "to_ship" | "awaiting_payment"; paymentStatus?: "paid" | "pending"; checkout?: boolean } = {}) {
  const { variant } = await insertProductVariant(db);
  const checkout = options.checkout ?? true;
  const order = await insertOrder(db, {
    ...(checkout ? checkoutOrderValues() : { channelId: "web", channelOrderNo: null }),
    ...(checkout ? shippingQuoteValues(options.quotedCost ?? 12_000) : {}),
    ...(checkout ? { shippingDestinationId: options.destination ?? MURAH, shippingAddressSnapshot: { ...SNAPSHOT, providerAreaId: options.destination ?? MURAH } } : {}),
    orderNo: uniqueOrderNo(),
    status: options.status ?? "to_ship",
    ...(checkout ? { paymentStatus: options.paymentStatus ?? "paid", paidAt: options.paymentStatus === "pending" ? null : new Date() } : {}),
    subtotalAmount: 518_000,
    shippingAmount: 0,
    totalAmount: 518_000,
  });
  await db.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 2, unitPrice: 259_000, unitCost: 100_000 });
  return { order, sku: variant.sku };
}

async function shipmentRows(db: TestDatabase, orderId: string) {
  return db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(shipments.attempt);
}

async function orderRow(db: TestDatabase, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

async function audits(db: TestDatabase, orderId: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityId, orderId), eq(auditLog.action, action)));
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ActionError);
  return (error as ActionError).message;
}

describe("bookShipment", () => {
  test("books the locked quote's service with the order's own address and stores the booking", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      const result = await bookShipment(tx, h.runtime, order.id, staff.id);
      expect(result).toMatchObject({ outcome: "booked", costAmount: 12_000, overQuote: false });

      expect(h.calls.create).toHaveLength(1);
      const sent = h.calls.create[0]!;
      expect(sent).toEqual({
        referenceId: `T-${order.orderNo}-K1`,
        origin: FAKE_SHIPMENT_ORIGIN,
        destination: { name: "Rina Uji", phone: "+6281200000002", address: SNAPSHOT.addressLine, areaId: MURAH, note: "Pagar hijau" },
        courierCode: "jne",
        serviceCode: "reg",
        item: { name: "Pakaian", value: 518_000, weightGrams: 900, quantity: 1 },
      });
      expect(JSON.stringify(sent)).not.toContain("pembeli@example.com");

      const [row] = await shipmentRows(tx, order.id);
      expect(row).toMatchObject({
        attempt: 1,
        referenceId: `T-${order.orderNo}-K1`,
        provider: "biteship",
        status: "pickup_requested",
        providerStatus: "confirmed",
        costAmount: 12_000,
        courier: "jne",
        service: "reg",
        bookedByStaffUserId: staff.id,
        lastError: null,
      });
      expect(row!.providerOrderId).toMatch(/^[0-9a-f]{24}$/);
      expect(row!.awb).toMatch(/^E2E[0-9]{13}$/);
      expect(row!.bookedAt).toBeInstanceOf(Date);
      // The order itself is untouched: status, resi and flags (K3 moves it at pickup).
      expect(await orderRow(tx, order.id)).toMatchObject({ status: "to_ship", trackingNumber: null, needsAttention: [] });
      expect(await audits(tx, order.id, "request_shipment_booking")).toHaveLength(1);
      expect(await audits(tx, order.id, "book_shipment")).toHaveLength(1);
    });
  });

  test("a second press finds the booking and never calls the provider again", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      const first = await bookShipment(tx, h.runtime, order.id, staff.id);
      const second = await bookShipment(tx, h.runtime, order.id, staff.id);
      expect(second).toEqual({ outcome: "already_booked", shipmentId: (first as { shipmentId: string }).shipmentId });
      expect(h.calls.create).toHaveLength(1);
      expect(await shipmentRows(tx, order.id)).toHaveLength(1);
    });
  });

  test("refuses orders that are not paid web orders in to_ship, without a configuration, or without an address", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const manual = await paidOrder(tx, { checkout: false });
      expect(await refusal(bookShipment(tx, h.runtime, manual.order.id, staff.id))).toBe(SHIPMENT_MESSAGES.notCheckout);
      const unpaid = await paidOrder(tx, { status: "awaiting_payment", paymentStatus: "pending" });
      expect(await refusal(bookShipment(tx, h.runtime, unpaid.order.id, staff.id))).toBe(SHIPMENT_MESSAGES.notReady);
      const ok = await paidOrder(tx);
      expect(await refusal(bookShipment(tx, null, ok.order.id, staff.id))).toBe(SHIPMENT_MESSAGES.noProvider);
      await tx.update(orders).set({ shippingAddressSnapshot: { version: 2 } }).where(eq(orders.id, ok.order.id));
      expect(await refusal(bookShipment(tx, h.runtime, ok.order.id, staff.id))).toBe(SHIPMENT_MESSAGES.noAddress);
      expect(h.calls.create).toHaveLength(0);
      expect(await shipmentRows(tx, ok.order.id)).toHaveLength(0);
    });
  });

  test("flags shipping_cost_over_quote only when the booked price is more than Rp5.000 above the quote", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const atThreshold = await paidOrder(tx, { quotedCost: 7_000 });
      expect(await bookShipment(tx, h.runtime, atThreshold.order.id, staff.id)).toMatchObject({ outcome: "booked", overQuote: false });
      expect((await orderRow(tx, atThreshold.order.id)).needsAttention).toEqual([]);
      const over = await paidOrder(tx, { quotedCost: 6_999 });
      await tx.update(orders).set({ needsAttention: ["refund_received"] }).where(eq(orders.id, over.order.id));
      expect(await bookShipment(tx, h.runtime, over.order.id, staff.id)).toMatchObject({ outcome: "booked", overQuote: true });
      expect((await orderRow(tx, over.order.id)).needsAttention).toEqual(["refund_received", "shipping_cost_over_quote"]);
    });
  });

  test("a booked price that arrives later is stored and checked then (null at booking, flag on the read)", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx, { quotedCost: 6_000 });
      h.next.create = async () => ({ ...(await h.fake.createShipment(h.calls.create.at(-1)!)), price: null });
      expect(await bookShipment(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "booked", costAmount: null, overQuote: false });
      expect((await orderRow(tx, order.id)).needsAttention).toEqual([]);
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "booked", costAmount: 12_000, overQuote: true });
      expect((await orderRow(tx, order.id)).needsAttention).toEqual(["shipping_cost_over_quote"]);
      // Cleared by staff, then read again at the same price: not raised again.
      await tx.update(orders).set({ needsAttention: [] }).where(eq(orders.id, order.id));
      await recheckBooking(tx, h.runtime, order.id, staff.id);
      expect((await orderRow(tx, order.id)).needsAttention).toEqual([]);
      const [row] = await shipmentRows(tx, order.id);
      expect(row!.routingCode).toBe("E2E-01");
    });
  });

  test("a clear refusal ends the attempt failed with its own message; the next press is attempt 2", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      h.next.create = () => Promise.reject(new ShipmentProviderError("refused", "balance", { status: 400, providerCode: 40002039 }));
      expect(await refusal(bookShipment(tx, h.runtime, order.id, staff.id))).toBe(SHIPMENT_MESSAGES.balance);
      h.next.create = () => Promise.reject(new ShipmentProviderError("refused", "key", { status: 400, providerCode: 40002002 }));
      expect(await refusal(bookShipment(tx, h.runtime, order.id, staff.id))).toBe(SHIPMENT_MESSAGES.inactiveKey);
      h.next.create = () => Promise.reject(new ShipmentProviderError("unavailable", "429", { status: 429 }));
      expect(await refusal(bookShipment(tx, h.runtime, order.id, staff.id))).toBe(SHIPMENT_MESSAGES.unavailable);
      h.next.create = () => Promise.reject(new ShipmentProviderError("budget_exhausted", "cap"));
      expect(await refusal(bookShipment(tx, h.runtime, order.id, staff.id))).toBe(SHIPMENT_MESSAGES.budget);
      expect(await bookShipment(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "booked" });
      const rows = await shipmentRows(tx, order.id);
      expect(rows.map((row) => [row.attempt, row.status, row.lastError])).toEqual([
        [1, "failed", "refused:40002039"],
        [2, "failed", "refused:40002002"],
        [3, "failed", "unavailable:http429"],
        [4, "failed", "budget_exhausted"],
        [5, "pickup_requested", null],
      ]);
      expect(rows[4]!.referenceId).toBe(`T-${order.orderNo}-K5`);
      expect(await audits(tx, order.id, "shipment_booking_failed")).toHaveLength(4);
    });
  });

  test("a lost answer keeps the attempt booking; Cek ulang re-sends the same reference and adopts the duplicate", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx, { destination: GANGGUAN });
      const lost = await bookShipment(tx, h.runtime, order.id, staff.id);
      expect(lost).toMatchObject({ outcome: "pending", referenceId: `T-${order.orderNo}-K1`, manualCheck: false });
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "booking", providerOrderId: null, lastError: "unavailable:unknown" }]);

      // Pressing "Pesan kurir" again never starts a second attempt while this one is open.
      expect(await bookShipment(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending" });
      expect(h.calls.create).toHaveLength(1);

      const rechecked = await recheckBooking(tx, h.runtime, order.id, staff.id);
      expect(rechecked).toMatchObject({ outcome: "booked" });
      expect(h.calls.create.map((input) => input.referenceId)).toEqual([`T-${order.orderNo}-K1`, `T-${order.orderNo}-K1`]);
      expect(h.store.byId.size).toBe(1);
      const [row] = await shipmentRows(tx, order.id);
      expect(row).toMatchObject({ status: "pickup_requested", providerOrderId: [...h.store.byId.keys()][0], lastError: null });
    });
  });

  test("Cek ulang never ends an attempt on a refusal or an unrecoverable duplicate: it stays for a manual check", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      h.next.create = () => Promise.reject(new ShipmentProviderError("unavailable", "timeout", { outcomeUnknown: true }));
      expect(await bookShipment(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending" });

      h.next.create = () => Promise.reject(new ShipmentProviderError("refused", "balance", { status: 400, providerCode: 40002039 }));
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending", manualCheck: true });
      h.next.create = () => Promise.reject(new ShipmentProviderError("duplicate_reference", "dup", { status: 400, providerCode: 40002060, outcomeUnknown: true }));
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending", manualCheck: true });

      // A duplicate naming an order with someone else's reference is never adopted.
      const foreign = await h.fake.createShipment({ ...h.calls.create[0]!, referenceId: "OTHER-REF-K1" });
      h.next.create = () => Promise.reject(new ShipmentProviderError("duplicate_reference", "dup", { status: 400, providerCode: 40002060, outcomeUnknown: true, existingOrderId: foreign.providerOrderId }));
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending", manualCheck: true });

      h.next.create = () => Promise.reject(new ShipmentProviderError("unavailable", "429", { status: 429 }));
      expect(await refusal(recheckBooking(tx, h.runtime, order.id, staff.id))).toBe(SHIPMENT_MESSAGES.recheckUnavailable);

      expect(await shipmentRows(tx, order.id)).toMatchObject([{ attempt: 1, status: "booking", providerOrderId: null, lastError: "unavailable:http429" }]);
    });
  });
});

describe("cancelShipment", () => {
  test("cancels before pickup; the attempt ends and the order can be booked again as attempt 2", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      expect(await cancelShipment(tx, h.runtime, order.id, { reasonCode: "change_courier" }, staff.id)).toMatchObject({ outcome: "cancelled" });
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "cancelled", providerStatus: "cancelled", cancelRequestedAt: null, cancelledByStaffUserId: staff.id }]);
      expect(await orderRow(tx, order.id)).toMatchObject({ status: "to_ship" });
      await bookShipment(tx, h.runtime, order.id, staff.id);
      const rows = await shipmentRows(tx, order.id);
      expect(rows.map((row) => [row.attempt, row.status])).toEqual([
        [1, "cancelled"],
        [2, "pickup_requested"],
      ]);
      expect(await audits(tx, order.id, "cancel_shipment")).toHaveLength(1);
    });
  });

  test("refuses after pickup (and stores what the provider says), and while the booking is not settled", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      const [row] = await shipmentRows(tx, order.id);
      // Picked up at the provider, not yet known here: the cancel is refused there and read.
      h.fake.controls.advance(row!.providerOrderId!, "picked");
      expect(await refusal(cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id))).toBe(SHIPMENT_MESSAGES.pastPickup);
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "picked_up", providerStatus: "picked", cancelRequestedAt: null }]);
      // Now known: refused before asking.
      expect(await refusal(cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id))).toBe(SHIPMENT_MESSAGES.pastPickup);
      expect(h.calls.cancel).toHaveLength(1);

      const pending = await paidOrder(tx, { destination: GANGGUAN });
      await bookShipment(tx, h.runtime, pending.order.id, staff.id);
      expect(await refusal(cancelShipment(tx, h.runtime, pending.order.id, { reasonCode: "others" }, staff.id))).toBe(SHIPMENT_MESSAGES.notBookedYet);
    });
  });

  test("a cancel that worked but lost its answer is read before staff are told: cancelled", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      const [row] = await shipmentRows(tx, order.id);
      h.next.cancel = async () => {
        await h.fake.cancelShipment(row!.providerOrderId!, { reasonCode: "others" });
        throw new ShipmentProviderError("unavailable", "timeout", { outcomeUnknown: true });
      };
      expect(await cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id)).toMatchObject({ outcome: "cancelled" });
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "cancelled" }]);
    });
  });

  test("a lost cancel answer whose order still waits for pickup stays requested until Cek ulang", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      h.next.cancel = () => Promise.reject(new ShipmentProviderError("unavailable", "timeout", { outcomeUnknown: true }));
      expect(await refusal(cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id))).toBe(SHIPMENT_MESSAGES.cancelUnknown);
      const [row] = await shipmentRows(tx, order.id);
      expect(row).toMatchObject({ status: "pickup_requested" });
      expect(row!.cancelRequestedAt).toBeInstanceOf(Date);
      // Cancelled at the provider later (e.g. the request did arrive): Cek ulang settles it.
      await h.fake.cancelShipment(row!.providerOrderId!, { reasonCode: "others" });
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "cancelled" });
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "cancelled", cancelRequestedAt: null }]);
    });
  });

  test("a refused or unreachable cancel withdraws the request and changes nothing else", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      h.next.cancel = () => Promise.reject(new ShipmentProviderError("unavailable", "down", { status: 503 }));
      expect(await refusal(cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id))).toBe(SHIPMENT_MESSAGES.cancelUnavailable);
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "pickup_requested", cancelRequestedAt: null, lastError: "unavailable:http503" }]);
    });
  });
});

describe("order rules around a booking", () => {
  test("a staff cancel of the order is refused while a courier is booked, and allowed once the shipment is cancelled", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      expect(await refusal(cancelCheckoutOrderByStaff(tx, null, order.id, staff.id))).toBe(STAFF_CANCEL_MESSAGES.liveShipment);
      await cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id);
      // No stock movements were written for this fixture, so only the guard is under test here.
      const outcome = await cancelCheckoutOrderByStaff(tx, null, order.id, staff.id).catch((error: unknown) => error);
      expect(outcome).not.toEqual(expect.objectContaining({ message: STAFF_CANCEL_MESSAGES.liveShipment }));
    });
  });

  test("a resi other than the booked waybill flags tracking_number_mismatch; correcting it clears the flag", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      const [row] = await shipmentRows(tx, order.id);
      await transitionOrderStatus(order.id, "shipped", staff.id, tx, { courier: "JNE Reguler", trackingNumber: "JNE0000000001" });
      expect(await orderRow(tx, order.id)).toMatchObject({ status: "shipped", trackingNumber: "JNE0000000001", needsAttention: ["tracking_number_mismatch"] });
      await updateShipmentDetails(order.id, { courier: "JNE Reguler", trackingNumber: row!.awb }, staff.id, tx);
      expect(await orderRow(tx, order.id)).toMatchObject({ trackingNumber: row!.awb, needsAttention: [] });

      // The booked waybill itself: no flag.
      const other = await paidOrder(tx);
      await bookShipment(tx, h.runtime, other.order.id, staff.id);
      const [otherRow] = await shipmentRows(tx, other.order.id);
      await transitionOrderStatus(other.order.id, "shipped", staff.id, tx, { courier: "JNE Reguler", trackingNumber: otherRow!.awb });
      expect((await orderRow(tx, other.order.id)).needsAttention).toEqual([]);
    });
  });
});

describe("review fixes", () => {
  test("a read taken before a cancel finished never makes the ended attempt live again", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      await bookShipment(tx, h.runtime, order.id, staff.id);
      const [row] = await shipmentRows(tx, order.id);
      // Cek ulang reads the order ("confirmed"); before its answer is stored, a cancel completes.
      const realGet = h.runtime.provider.getShipment.bind(h.runtime.provider);
      h.runtime.provider.getShipment = async (id) => {
        const stale = await realGet(id);
        h.runtime.provider.getShipment = realGet;
        await cancelShipment(tx, h.runtime, order.id, { reasonCode: "others" }, staff.id);
        return stale;
      };
      await recheckBooking(tx, h.runtime, order.id, staff.id);
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ id: row!.id, status: "cancelled" }]);
      // And the order can be booked again.
      expect(await bookShipment(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "booked" });
    });
  });

  test("Cek ulang does not re-send a booking for an order that was shipped by hand meanwhile; the manual ship is flagged", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      h.next.create = () => Promise.reject(new ShipmentProviderError("unavailable", "timeout", { outcomeUnknown: true }));
      await bookShipment(tx, h.runtime, order.id, staff.id);
      await transitionOrderStatus(order.id, "shipped", staff.id, tx, { courier: "JNE Reguler", trackingNumber: "JNE0000000009" });
      expect((await orderRow(tx, order.id)).needsAttention).toEqual(["tracking_number_mismatch"]);
      expect(await recheckBooking(tx, h.runtime, order.id, staff.id)).toMatchObject({ outcome: "pending", manualCheck: true });
      expect(h.calls.create).toHaveLength(1);
      expect(await shipmentRows(tx, order.id)).toMatchObject([{ status: "booking", lastError: "order_moved_on" }]);
    });
  });

  test("a waybill that arrives after staff typed another resi raises the mismatch flag", async () => {
    await withRollback(async (tx) => {
      const h = harness();
      const staff = await insertStaffUser(tx);
      const { order } = await paidOrder(tx);
      h.next.create = async () => ({ ...(await h.fake.createShipment(h.calls.create.at(-1)!)), waybillId: null });
      await bookShipment(tx, h.runtime, order.id, staff.id);
      await transitionOrderStatus(order.id, "shipped", staff.id, tx, { courier: "JNE Reguler", trackingNumber: "JNE0000000009" });
      expect((await orderRow(tx, order.id)).needsAttention).toEqual([]);
      await recheckBooking(tx, h.runtime, order.id, staff.id);
      expect((await orderRow(tx, order.id)).needsAttention).toEqual(["tracking_number_mismatch"]);
    });
  });
});

describe("races (committed transactions)", () => {
  test("two Pesan kurir at once: one booking at the provider, one live shipment, never two", async () => {
    for (let round = 0; round < 5; round += 1) {
      const h = harness();
      const staffA = await insertStaffUser(testDb);
      const staffB = await insertStaffUser(testDb);
      const { order, sku } = await paidOrder(testDb);
      try {
        const results = await Promise.all([bookShipment(testDb, h.runtime, order.id, staffA.id), bookShipment(testDb, h.runtime, order.id, staffB.id)]);
        // The loser sees the winner's attempt: still in flight ("pending") or already booked.
        const outcomes = results.map((result) => result.outcome);
        expect(outcomes.filter((outcome) => outcome === "booked")).toHaveLength(1);
        expect(["already_booked", "pending"]).toContain(outcomes.find((outcome) => outcome !== "booked"));
        expect(h.calls.create).toHaveLength(1);
        expect(h.store.byId.size).toBe(1);
        const rows = await shipmentRows(testDb, order.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ attempt: 1, status: "pickup_requested" });
      } finally {
        await cleanUp([order.id], [sku], [staffA.id, staffB.id]);
      }
    }
  });
});

async function cleanUp(orderIds: string[], skus: string[], staffIds: string[]): Promise<void> {
  const shipmentIds = (await testDb.select({ id: shipments.id }).from(shipments).where(inArray(shipments.orderId, orderIds))).map((row) => row.id);
  if (shipmentIds.length > 0) await testDb.delete(shipmentEvents).where(inArray(shipmentEvents.shipmentId, shipmentIds));
  await testDb.delete(shipments).where(inArray(shipments.orderId, orderIds));
  await testDb.delete(auditLog).where(inArray(auditLog.entityId, orderIds));
  await testDb.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
  await testDb.delete(orders).where(inArray(orders.id, orderIds));
  const variantRows = await testDb.select({ productId: productVariants.productId, colorId: productVariants.fabricColorId, fabricId: productVariants.fabricId }).from(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(products).where(inArray(products.id, variantRows.map((row) => row.productId)));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, variantRows.map((row) => row.colorId)));
  await testDb.delete(fabrics).where(inArray(fabrics.id, variantRows.map((row) => row.fabricId)));
  await testDb.delete(auditLog).where(inArray(auditLog.actorStaffUserId, staffIds));
  await testDb.delete(staffUsers).where(inArray(staffUsers.id, staffIds));
}
