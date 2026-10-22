import { and, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { claimRateLimits } from "@ammari/db/schema";
import { BITESHIP_ORDER_CREATED, BITESHIP_ORDER_PICKED } from "./biteship-fixtures";
import { SHIPPING_BUDGET_ACTIONS, SHIPPING_BUDGET_IP } from "./budget";
import { FAKE_SHIPPING_AREAS } from "./fake";
import { FAKE_SHIPMENT_REFUSED_CODE, createFakeShipmentProvider, createFakeShipmentStore } from "./fake-shipments";
import { FAKE_SHIPMENT_ORIGIN, shipmentRuntimeFromEnv } from "./shipment-config";
import { ShipmentProviderError, type CreateShipmentInput } from "./shipment-provider";
import { shippingRuntimeFromEnv } from "./config";
import { fakeBiteshipKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §15 Phase K, K1: the fake booking provider and the shipment runtime
// from the environment (incl. its daily budgets against the test database). Nothing here reaches
// Biteship.

function booking(overrides: Partial<CreateShipmentInput> = {}): CreateShipmentInput {
  return {
    referenceId: "E2E-ORD-202612-0001-K1",
    origin: FAKE_SHIPMENT_ORIGIN,
    destination: { name: "Rina Uji", phone: "+6281200000002", address: "Jalan Uji No. 2", areaId: "E2EMURAH40111" },
    courierCode: "jne",
    serviceCode: "reg",
    item: { name: "Pakaian", value: 269_000, weightGrams: 900, quantity: 1 },
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<ShipmentProviderError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ShipmentProviderError);
  return error as ShipmentProviderError;
}

describe("FakeShipmentProvider", () => {
  test("its special destinations are fake rate areas (a drift would silently turn them into normal bookings)", () => {
    const ids = FAKE_SHIPPING_AREAS.map((area) => area.providerAreaId);
    expect(ids).toEqual(expect.arrayContaining(["E2EGANGGUAN40333", "E2ETANPALAYANAN40222", "E2EMURAH40111"]));
  });

  function fake() {
    let clock = new Date("2026-12-02T03:00:00.000Z");
    const provider = createFakeShipmentProvider({
      store: createFakeShipmentStore(),
      now: () => {
        clock = new Date(clock.getTime() + 60_000);
        return clock;
      },
    });
    return provider;
  }

  test("books at the fake area's quoted price with a waybill that passes the resi rule", async () => {
    const provider = fake();
    const shipment = await provider.createShipment(booking());
    expect(shipment).toMatchObject({ referenceId: "E2E-ORD-202612-0001-K1", knownStatus: "confirmed", status: "pickup_requested", price: 12_000, courierCode: "jne", serviceCode: "reg" });
    expect(shipment.waybillId).toMatch(/^[A-Z0-9-]{6,40}$/);
    expect(shipment.history.map((entry) => entry.providerStatus)).toEqual(["confirmed"]);
    expect(await provider.getShipment(shipment.providerOrderId)).toMatchObject({ providerOrderId: shipment.providerOrderId, routingCode: "E2E-01" });
  });

  test("a repeated reference is a duplicate naming the existing order, never a second booking", async () => {
    const provider = fake();
    const first = await provider.createShipment(booking());
    const error = await caught(provider.createShipment(booking()));
    expect(error).toMatchObject({ reason: "duplicate_reference", existingOrderId: first.providerOrderId, outcomeUnknown: true });
  });

  test("the lost-answer area books, loses the answer once, then answers duplicate", async () => {
    const provider = fake();
    const input = booking({ destination: { ...booking().destination, areaId: "E2EGANGGUAN40333" } });
    const lost = await caught(provider.createShipment(input));
    expect(lost).toMatchObject({ reason: "unavailable", outcomeUnknown: true });
    const again = await caught(provider.createShipment(input));
    expect(again.reason).toBe("duplicate_reference");
    expect(provider.controls.get(again.existingOrderId!)).toMatchObject({ knownStatus: "confirmed" });
  });

  test("the no-service area is refused and nothing is stored", async () => {
    const provider = fake();
    const input = booking({ destination: { ...booking().destination, areaId: "E2ETANPALAYANAN40222" } });
    expect(await caught(provider.createShipment(input))).toMatchObject({ reason: "refused", providerCode: FAKE_SHIPMENT_REFUSED_CODE, outcomeUnknown: false });
    // Not stored: the same reference books normally once the cause is fixed.
    await expect(provider.createShipment({ ...input, destination: booking().destination })).resolves.toMatchObject({ knownStatus: "confirmed" });
  });

  test("advance, re-weigh and waybill change are what the next read sees", async () => {
    const provider = fake();
    const { providerOrderId } = await provider.createShipment(booking());
    provider.controls.advance(providerOrderId, "allocated");
    provider.controls.advance(providerOrderId, "pickingUp");
    provider.controls.advance(providerOrderId, "picked");
    provider.controls.setPrice(providerOrderId, 19_000);
    provider.controls.setWaybill(providerOrderId, "E2E9999999999");
    const read = await provider.getShipment(providerOrderId);
    expect(read).toMatchObject({ knownStatus: "picked", status: "picked_up", price: 19_000, waybillId: "E2E9999999999" });
    expect(read.driver).toMatchObject({ name: "Kurir E2E" });
    expect(read.history.map((entry) => entry.providerStatus)).toEqual(["confirmed", "allocated", "picking_up", "picked"]);
    expect(read.history.every((entry, index, all) => index === 0 || entry.occurredAt > all[index - 1]!.occurredAt)).toBe(true);
    expect(() => provider.controls.advance(providerOrderId, "teleported")).toThrow(RangeError);
  });

  test("reads are copies: changing one never changes the store", async () => {
    const provider = fake();
    const shipment = await provider.createShipment(booking());
    shipment.history.push({ providerStatus: "delivered", status: "delivered", note: "", occurredAt: new Date() });
    shipment.price = 1;
    expect(await provider.getShipment(shipment.providerOrderId)).toMatchObject({ price: 12_000, history: [expect.objectContaining({ providerStatus: "confirmed" })] });
  });

  test("cancel only before pickup", async () => {
    const provider = fake();
    const early = await provider.createShipment(booking());
    expect(await provider.cancelShipment(early.providerOrderId, { reasonCode: "others", reason: "uji" })).toEqual({ providerOrderId: early.providerOrderId, providerStatus: "cancelled" });
    expect((await provider.getShipment(early.providerOrderId)).status).toBe("cancelled");

    const late = await provider.createShipment(booking({ referenceId: "E2E-ORD-202612-0002-K1" }));
    provider.controls.advance(late.providerOrderId, "picked");
    expect((await caught(provider.cancelShipment(late.providerOrderId, { reasonCode: "others" }))).reason).toBe("not_cancellable");
  });

  test("an unknown order is not found", async () => {
    expect((await caught(fake().getShipment("ffffffffffffffffffffffff"))).reason).toBe("not_found");
  });
});

describe("shipmentRuntimeFromEnv", () => {
  const complete = {
    BITESHIP_API_KEY: fakeBiteshipKey("test"),
    BITESHIP_BASE_URL: "https://api.biteship.com",
    BITESHIP_ORIGIN_AREA_ID: "IDNP9IDNC23IDND245IDZ40132",
    BITESHIP_SHIPPER_NAME: "Ammari",
    BITESHIP_SHIPPER_PHONE: "0812-0000-0001",
    BITESHIP_SHIPPER_ADDRESS: "Jalan Contoh No. 1, Kelurahan Contoh",
    BITESHIP_REFERENCE_PREFIX: "DEV-",
    DEPLOY_ENV: "dev",
  };

  test("the Biteship client with the sender and prefix when everything is set", async () => {
    await withRollback(async (tx) => {
      const result = shipmentRuntimeFromEnv(tx, complete);
      if (!result.ok) throw new Error(result.problems.join("; "));
      expect(result.runtime.provider.name).toBe("biteship");
      expect(result.runtime.origin).toEqual({ name: "Ammari", phone: "+6281200000001", address: "Jalan Contoh No. 1, Kelurahan Contoh", areaId: complete.BITESHIP_ORIGIN_AREA_ID });
      expect(result.runtime.referencePrefix).toBe("DEV-");
    });
  });

  test("nothing set: every variable named, no values", async () => {
    await withRollback(async (tx) => {
      expect(shipmentRuntimeFromEnv(tx, {})).toEqual({
        ok: false,
        problems: [
          "BITESHIP_API_KEY is not set",
          "BITESHIP_BASE_URL is not set",
          "BITESHIP_ORIGIN_AREA_ID is not set",
          "BITESHIP_SHIPPER_NAME must be 2 to 60 characters",
          "BITESHIP_SHIPPER_PHONE must be an Indonesian mobile number",
          "BITESHIP_SHIPPER_ADDRESS must be 10 to 300 characters",
        ],
      });
    });
  });

  test("bad sender values are refused by name only", async () => {
    await withRollback(async (tx) => {
      const result = shipmentRuntimeFromEnv(tx, {
        ...complete,
        BITESHIP_SHIPPER_NAME: "A",
        BITESHIP_SHIPPER_PHONE: "022-1234567",
        BITESHIP_SHIPPER_ADDRESS: "pendek",
        BITESHIP_DAILY_ORDERS_BUDGET: "0",
      });
      expect(result).toEqual({
        ok: false,
        problems: [
          "BITESHIP_SHIPPER_NAME must be 2 to 60 characters",
          "BITESHIP_SHIPPER_PHONE must be an Indonesian mobile number",
          "BITESHIP_SHIPPER_ADDRESS must be 10 to 300 characters",
          "BITESHIP_DAILY_ORDERS_BUDGET must be a positive whole number",
        ],
      });
      expect(JSON.stringify(result)).not.toContain("022");
    });
  });

  test("the reference prefix: pattern everywhere, required outside production", async () => {
    await withRollback(async (tx) => {
      for (const prefix of ["dev-", "DEV_", "TOO-LONG-PREFIX-XX"]) {
        expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_REFERENCE_PREFIX: prefix })).toEqual({
          ok: false,
          problems: ["BITESHIP_REFERENCE_PREFIX must be A-Z, 0-9 or '-', at most 16 characters"],
        });
      }
      for (const prefix of ["DEV-", "LOCAL-", "E2E-", "CT-", "TEST-"]) {
        expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live"), DEPLOY_ENV: "production", BITESHIP_REFERENCE_PREFIX: prefix })).toEqual({
          ok: false,
          problems: ["BITESHIP_REFERENCE_PREFIX names a test environment but DEPLOY_ENV is production"],
        });
      }
      for (const prefix of [undefined, "", "  "]) {
        expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_REFERENCE_PREFIX: prefix })).toEqual({
          ok: false,
          problems: ["BITESHIP_REFERENCE_PREFIX must be set outside production (e.g. DEV- or LOCAL-)"],
        });
      }
      const prod = shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live"), DEPLOY_ENV: "production", BITESHIP_REFERENCE_PREFIX: "" });
      expect(prod.ok && prod.runtime.referencePrefix).toBe("");
      const prodPrefixed = shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live"), DEPLOY_ENV: "production", BITESHIP_REFERENCE_PREFIX: "PRD-" });
      expect(prodPrefixed.ok && prodPrefixed.runtime.referencePrefix).toBe("PRD-");
    });
  });

  test("a live key books real pickups: refused outside production; a test key refused in production", async () => {
    await withRollback(async (tx) => {
      for (const deployEnv of ["dev", "development", "test", undefined]) {
        expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live"), DEPLOY_ENV: deployEnv })).toEqual({
          ok: false,
          problems: ["BITESHIP_API_KEY is not a test key but DEPLOY_ENV is not production (bookings would call real couriers)"],
        });
      }
      expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: "something-else", DEPLOY_ENV: "dev" }).ok).toBe(false);
      expect(shipmentRuntimeFromEnv(tx, { ...complete, DEPLOY_ENV: "production" })).toEqual({
        ok: false,
        problems: ["BITESHIP_API_KEY is a test key but DEPLOY_ENV is production or unset"],
      });
      expect(shipmentRuntimeFromEnv(tx, { ...complete, NODE_ENV: "production", DEPLOY_ENV: "prod" }).ok).toBe(false);
      // The rate runtime keeps allowing a live key on dev (rates only cost a few rupiah).
      expect(shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live") }).ok).toBe(true);
    });
  });

  test("the key only ever goes to Biteship's own host, without a path", async () => {
    await withRollback(async (tx) => {
      expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_BASE_URL: "https://api.biteship.com/v1/" })).toEqual({
        ok: false,
        problems: ["BITESHIP_BASE_URL must be https://api.biteship.com"],
      });
      expect(shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_BASE_URL: "https://api.biteship.com.evil.example" })).toEqual({
        ok: false,
        problems: ["BITESHIP_BASE_URL must be https://api.biteship.com"],
      });
    });
  });

  test("the fake only in an e2e run; an unknown provider is refused", async () => {
    await withRollback(async (tx) => {
      const e2e = shipmentRuntimeFromEnv(tx, { SHIPPING_ORDER_PROVIDER: "fake", NODE_ENV: "development", E2E_TEST_LOGIN: "true" });
      expect(e2e.ok && e2e.runtime.provider.name).toBe("fake");
      expect(e2e.ok && e2e.runtime.referencePrefix).toBe("E2E-");
      expect(shipmentRuntimeFromEnv(tx, { SHIPPING_ORDER_PROVIDER: "fake", NODE_ENV: "production", E2E_TEST_LOGIN: "true" }).ok).toBe(false);
      expect(shipmentRuntimeFromEnv(tx, { SHIPPING_ORDER_PROVIDER: "fake", NODE_ENV: "development" }).ok).toBe(false);
      expect(shipmentRuntimeFromEnv(tx, { ...complete, SHIPPING_ORDER_PROVIDER: "komerce" })).toEqual({ ok: false, problems: ["SHIPPING_ORDER_PROVIDER must be biteship or fake"] });
    });
  });

  test("reads draw on the orders budget, bookings on the write budget, each before the request", async () => {
    await withRollback(async (tx) => {
      await tx.delete(claimRateLimits).where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = url.endsWith("/v1/orders") ? { ...BITESHIP_ORDER_CREATED, reference_id: booking().referenceId } : BITESHIP_ORDER_PICKED;
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const result = shipmentRuntimeFromEnv(tx, { ...complete, BITESHIP_DAILY_ORDERS_BUDGET: "1" });
      if (!result.ok) throw new Error(result.problems.join("; "));
      try {
        await result.runtime.provider.getShipment(BITESHIP_ORDER_PICKED.id);
        expect((await caught(result.runtime.provider.getShipment(BITESHIP_ORDER_PICKED.id))).reason).toBe("budget_exhausted");
        // The read budget being spent never blocks a booking.
        await result.runtime.provider.createShipment(booking({ origin: result.runtime.origin }));
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
      }
      const rows = await tx.select().from(claimRateLimits).where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      expect(rows.filter((row) => row.action === SHIPPING_BUDGET_ACTIONS.orders)).toHaveLength(2);
      expect(rows.filter((row) => row.action === SHIPPING_BUDGET_ACTIONS.order_writes)).toHaveLength(1);
      expect(await tx.select().from(claimRateLimits).where(and(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP), eq(claimRateLimits.action, SHIPPING_BUDGET_ACTIONS.rates)))).toHaveLength(0);
    });
  });
});
