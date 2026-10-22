import { describe, expect, test } from "vitest";
import {
  SHIPMENT_TRACKING_STATUSES,
  shipmentPickupState,
  BITESHIP_CANCELLABLE_STATUSES,
  BITESHIP_FINAL_STATUSES,
  BITESHIP_ORDER_STATUSES,
  canonicalBiteshipStatus,
  isShippingCostOverQuote,
  normalizeBiteshipStatus,
  pickupCutoffFor,
  shipmentReferenceId,
  toBiteshipPhone,
} from "./shipment-rules";
import { SHIPPING_SERVICE_ALLOWLIST } from "./rules";
import { SHIPMENT_STATUSES } from "@ammari/db/schema";

describe("Biteship status normalization", () => {
  test.each([
    ["confirmed", "pickup_requested"],
    ["scheduled", "pickup_requested"],
    ["allocated", "pickup_requested"],
    ["picking_up", "pickup_requested"],
    ["picked", "picked_up"],
    ["in_transit", "in_transit"],
    ["dropping_off", "in_transit"],
    ["delivered", "delivered"],
    ["on_hold", "problem"],
    ["return_in_transit", "returning"],
    ["returned", "returned"],
    ["rejected", "problem"],
    ["disposed", "problem"],
    ["courier_not_found", "cancelled"],
    ["cancelled", "cancelled"],
  ])("%s -> %s", (raw, normalized) => {
    expect(normalizeBiteshipStatus(raw)).toBe(normalized);
  });

  test("every documented status has a mapping", () => {
    for (const status of BITESHIP_ORDER_STATUSES) expect(normalizeBiteshipStatus(status)).not.toBeNull();
  });

  test.each([
    ["pickingUp", "picking_up"],
    ["inTransit", "in_transit"],
    ["droppingOff", "dropping_off"],
    ["returnInTransit", "return_in_transit"],
    ["onHold", "on_hold"],
    ["courierNotFound", "courier_not_found"],
    ["  DELIVERED ", "delivered"],
    ["picking up", "picking_up"],
    ["picking-up", "picking_up"],
    ["canceled", "cancelled"],
    ["Canceled", "cancelled"],
  ])("the tracking page's spelling %j is the order status %s", (raw, canonical) => {
    expect(canonicalBiteshipStatus(raw)).toBe(canonical);
  });

  test.each(["", "done", "deliver", "delivered_to_neighbour", "in transit please"])("unknown %j is null, never a state", (raw) => {
    expect(canonicalBiteshipStatus(raw)).toBeNull();
    expect(normalizeBiteshipStatus(raw)).toBeNull();
  });

  test("only the statuses before pickup can be cancelled", () => {
    expect([...BITESHIP_CANCELLABLE_STATUSES].sort()).toEqual(["allocated", "confirmed", "picking_up", "scheduled"]);
  });

  test("final statuses: delivered, returned and every way a shipment ends without delivery", () => {
    expect([...BITESHIP_FINAL_STATUSES].sort()).toEqual(["cancelled", "courier_not_found", "delivered", "disposed", "rejected", "returned"]);
    for (const status of BITESHIP_CANCELLABLE_STATUSES) expect(BITESHIP_FINAL_STATUSES.has(status)).toBe(false);
  });
});

describe("shipmentReferenceId", () => {
  test("prefix, order number and attempt", () => {
    expect(shipmentReferenceId("DEV-", "ORD-202612-0001", 1)).toBe("DEV-ORD-202612-0001-K1");
    expect(shipmentReferenceId("", "ORD-202612-0001", 12)).toBe("ORD-202612-0001-K12");
  });

  test.each(["dev-", "DEV_", "DEV PREFIX", "A".repeat(17)])("refuses the prefix %j", (prefix) => {
    expect(() => shipmentReferenceId(prefix, "ORD-202612-0001", 1)).toThrow(RangeError);
  });

  test.each([0, -1, 1.5, 100, Number.NaN])("refuses attempt %s", (attempt) => {
    expect(() => shipmentReferenceId("DEV-", "ORD-202612-0001", attempt)).toThrow(RangeError);
  });

  test("refuses an order number that could break the reference", () => {
    expect(() => shipmentReferenceId("DEV-", "ord 1", 1)).toThrow(RangeError);
    expect(() => shipmentReferenceId("DEV-", "", 1)).toThrow(RangeError);
  });
});

describe("toBiteshipPhone", () => {
  test("+62 mobile to the local 08 form", () => {
    expect(toBiteshipPhone("+6281234567890")).toBe("081234567890");
  });

  test.each(["081234567890", "+62212345678", "+6581234567", "+628123"])("refuses %j", (phone) => {
    expect(() => toBiteshipPhone(phone)).toThrow(RangeError);
  });
});

describe("pickup cut-offs", () => {
  test("every allowlisted courier has a cut-off hint", () => {
    for (const service of SHIPPING_SERVICE_ALLOWLIST) expect(pickupCutoffFor(service.courierCode)).toMatch(/^[0-2][0-9]\.[0-5][0-9]$/);
  });

  test("documented values and an unknown courier", () => {
    expect(pickupCutoffFor("JNE")).toBe("14.00");
    expect(pickupCutoffFor("jnt")).toBe("15.59");
    expect(pickupCutoffFor("sicepat")).toBe("17.00");
    expect(pickupCutoffFor("gojek")).toBeNull();
  });
});

describe("isShippingCostOverQuote", () => {
  test.each([
    [35_000, 35_000, false],
    [40_000, 35_000, false],
    [40_001, 35_000, true],
    [30_000, 35_000, false],
    [100_000, 35_000, true],
  ])("actual %i vs quote %i -> %s", (actual, quoted, flagged) => {
    expect(isShippingCostOverQuote(actual, quoted)).toBe(flagged);
  });
});

describe("shipmentPickupState", () => {
  test("waiting, on the way, picked up; null for ended, problem or unknown statuses", () => {
    expect(["confirmed", "scheduled", "allocated"].map(shipmentPickupState)).toEqual(["waiting", "waiting", "waiting"]);
    expect(shipmentPickupState("pickingUp")).toBe("courier_on_the_way");
    expect(["picked", "in_transit", "dropping_off", "delivered", "return_in_transit", "returned"].map(shipmentPickupState)).toEqual(Array(6).fill("picked_up"));
    expect(["cancelled", "courier_not_found", "on_hold", "rejected", "disposed", "teleported", null].map(shipmentPickupState)).toEqual(Array(7).fill(null));
  });

  test("our shipment statuses are the booking states plus every normalized tracking state (the DB CHECK uses the first)", () => {
    expect([...SHIPMENT_STATUSES]).toEqual(["booking", "failed", ...SHIPMENT_TRACKING_STATUSES]);
  });
});
