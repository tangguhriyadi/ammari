import { describe, expect, test } from "vitest";
import { BUYER_TRACKING_MAX_EVENTS, buyerTracking, buyerTrackingLabel, type BuyerTrackingInput, type TrackingEventInput } from "./tracking";

// docs/plans/cart-checkout.md §9.1, §15 Phase K, K4: what the buyer's "Lacak pengiriman" timeline
// shows for a courier booking and its events.

const T0 = new Date("2026-12-02T03:00:00Z"); // 10.00 WIB
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function event(providerStatus: string, minutes: number, overrides: Partial<TrackingEventInput> = {}): TrackingEventInput {
  return { occurredAt: at(minutes), providerStatus, normalizedStatus: null, description: "", location: null, ...overrides };
}

function input(overrides: Partial<BuyerTrackingInput> = {}): BuyerTrackingInput {
  return {
    orderStatus: "shipped",
    trackingNumber: "WYB-1792634407489",
    shipment: { awb: "WYB-1792634407489", status: "in_transit", lastError: null, staleFlaggedAt: null, lastEventAt: at(60), bookedAt: T0, createdAt: T0 },
    events: [event("confirmed", 0), event("picked", 60, { normalizedStatus: "picked_up" }), event("allocated", 10)],
    ...overrides,
  };
}

describe("buyerTracking", () => {
  test("latest first, Indonesian labels, times in WIB", () => {
    const tracking = buyerTracking(input());
    expect(tracking.events.map((entry) => entry.label)).toEqual(["Paket dijemput kurir", "Kurir sudah ditugaskan", "Kurir dipesan"]);
    expect(tracking.events[0]!.at).toBe("2 Desember 2026, 11.00 WIB");
    expect(tracking.events[0]!.dateTime).toBe(at(60).toISOString());
    expect(tracking.delay).toBeNull();
  });

  test("entries with the same time: the later step goes on top", () => {
    const tracking = buyerTracking(input({ events: [event("picked", 5, { normalizedStatus: "picked_up" }), event("confirmed", 5)] }));
    expect(tracking.events.map((entry) => entry.label)).toEqual(["Paket dijemput kurir", "Kurir dipesan"]);
    const reversed = buyerTracking(input({ events: [event("confirmed", 5), event("picked", 5, { normalizedStatus: "picked_up" })] }));
    expect(reversed.events.map((entry) => entry.label)).toEqual(["Paket dijemput kurir", "Kurir dipesan"]);
  });

  test("every documented status has its own words; an unknown one falls back to its state, then to a neutral line", () => {
    for (const status of ["confirmed", "scheduled", "allocated", "picking_up", "picked", "in_transit", "dropping_off", "delivered", "on_hold", "rejected", "disposed", "courier_not_found", "return_in_transit", "returned", "cancelled"]) {
      expect(buyerTrackingLabel(status, null)).not.toBe("Kabar dari kurir");
    }
    expect(buyerTrackingLabel("pickedUp", "picked_up")).toBe("Paket dijemput kurir");
    expect(buyerTrackingLabel("sorting_hub", null)).toBe("Kabar dari kurir");
  });

  test("the courier's note and place are shown on one line; a note naming the provider or carrying a phone number never is", () => {
    const tracking = buyerTracking(
      input({
        events: [
          event("in_transit", 90, { description: "Paket tiba di\nhub Bandung", location: "Bandung" }),
          event("allocated", 10, { description: "Biteship is looking for a driver" }),
          event("confirmed", 0, { description: "   " }),
          event("picking_up", 20, { description: "Kurir Budi (0812-3456-7890) menuju lokasi" }),
          event("picked", 30, { description: "Diterima oleh +62 812 3456 789" }),
        ],
      }),
    );
    expect(tracking.events.map((entry) => entry.note)).toEqual(["Paket tiba di hub Bandung · Bandung", null, null, null, null]);
  });

  test("a long note is cut; only the newest entries are kept", () => {
    const many = Array.from({ length: BUYER_TRACKING_MAX_EVENTS + 5 }, (_, index) => event("in_transit", index, { description: "x".repeat(300) }));
    const tracking = buyerTracking(input({ events: many }));
    expect(tracking.events).toHaveLength(BUYER_TRACKING_MAX_EVENTS);
    expect(tracking.events[0]!.dateTime).toBe(at(BUYER_TRACKING_MAX_EVENTS + 4).toISOString());
    expect(tracking.events[0]!.note!.length).toBeLessThanOrEqual(200);
  });

  test("no booking, or a resi that is not the booking's waybill: no timeline and no note (a different parcel)", () => {
    expect(buyerTracking(input({ shipment: null }))).toEqual({ events: [], delay: null });
    expect(buyerTracking(input({ trackingNumber: "JNE0001234567" }))).toEqual({ events: [], delay: null });
    const unbooked = input();
    expect(buyerTracking({ ...unbooked, shipment: { ...unbooked.shipment!, awb: null } })).toEqual({ events: [], delay: null });
    // Same resi written differently still matches.
    expect(buyerTracking(input({ trackingNumber: "wyb-1792634407489 " })).events).toHaveLength(3);
    // Before the order ships it has no resi yet: the booking's own timeline shows.
    expect(buyerTracking(input({ orderStatus: "to_ship", trackingNumber: null })).events).toHaveLength(3);
  });

  test("a failed automatic read or a stale spell shows a gentle note while the parcel is on its way", () => {
    const base = input();
    const shipment = base.shipment!;
    expect(buyerTracking({ ...base, shipment: { ...shipment, lastError: "read:budget_exhausted" } }).delay).toBe("read");
    expect(buyerTracking({ ...base, shipment: { ...shipment, lastError: "read:unavailable" } }).delay).toBe("read");
    // A read that fails for good is staff's to check: no promise of an automatic re-check.
    expect(buyerTracking({ ...base, shipment: { ...shipment, lastError: "read:not_found" } }).delay).toBe("stale");
    expect(buyerTracking({ ...base, shipment: { ...shipment, staleFlaggedAt: at(60 * 24 * 5) } }).delay).toBe("stale");
    // A stale mark from before the newest event belongs to an earlier quiet spell.
    expect(buyerTracking({ ...base, shipment: { ...shipment, staleFlaggedAt: at(30) } }).delay).toBeNull();
    // A booking error is not a tracking delay.
    expect(buyerTracking({ ...base, shipment: { ...shipment, lastError: "refused:40002039" } }).delay).toBeNull();
    // Finished: no note.
    expect(buyerTracking({ ...base, orderStatus: "completed", shipment: { ...shipment, lastError: "read:unavailable" } }).delay).toBeNull();
    expect(buyerTracking({ ...base, shipment: { ...shipment, status: "delivered", lastError: "read:unavailable" } }).delay).toBeNull();
  });
});
