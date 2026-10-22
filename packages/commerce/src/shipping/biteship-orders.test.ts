import { describe, expect, test, vi } from "vitest";
import { createBiteshipOrdersClient, parseBiteshipOrder } from "./biteship-orders";
import {
  BITESHIP_ORDER_CANCELLED,
  BITESHIP_ORDER_CREATED,
  BITESHIP_ORDER_DUPLICATE_REFERENCE,
  BITESHIP_ORDER_NOT_CANCELLABLE,
  BITESHIP_ORDER_PICKED,
  BITESHIP_ORDER_REFUSED,
  BITESHIP_UNAUTHORIZED,
} from "./biteship-fixtures";
import { ShippingRateError } from "./provider";
import { ShipmentProviderError, type CreateShipmentInput, type ShipmentCallKind } from "./shipment-provider";
import { fakeBiteshipKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §15 Phase K, K1: the Biteship order client against hand-written
// fixtures through a stub fetch. Nothing here reaches the network.

const API_KEY = fakeBiteshipKey("test");
const BASE_URL = "https://biteship.invalid";
const ORDER_ID = BITESHIP_ORDER_CREATED.id;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(responses: Array<Response | Error>, beforeRequest?: (kind: ShipmentCallKind) => Promise<void>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = vi.fn(async (url: URL | Request | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const client = createBiteshipOrdersClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetch: fetchStub as unknown as typeof fetch,
    readRetryDelayMs: 1,
    beforeRequest,
  });
  return { client, calls, fetchStub };
}

const bookingInput: CreateShipmentInput = {
  referenceId: "DEV-ORD-202612-0001-K1",
  origin: { name: "Ammari", phone: "+6281200000001", address: "Jalan Contoh No. 1", areaId: "IDNP9IDNC23IDND245IDZ40132" },
  destination: {
    name: "Rina Contoh",
    phone: "+6281200000002",
    address: "Jalan Contoh No. 2, RT 01/RW 02, Kelurahan Contoh",
    areaId: "IDNP6IDNC148IDND843IDZ12250",
    note: "Pagar hitam",
  },
  courierCode: "jne",
  serviceCode: "reg",
  item: { name: "Pakaian", value: 538_000, weightGrams: 1_500, quantity: 1 },
  orderNote: "ORD-202612-0001",
};

async function caught(promise: Promise<unknown>): Promise<ShipmentProviderError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ShipmentProviderError);
  return error as ShipmentProviderError;
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

describe("createShipment", () => {
  test("sends the documented booking: pickup now, locked courier and service, area ids, one item, no email, insurance or COD", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_ORDER_CREATED)]);
    await client.createShipment(bookingInput);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/orders`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(API_KEY);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      shipper_contact_name: "Ammari",
      shipper_contact_phone: "081200000001",
      shipper_organization: "Ammari",
      origin_contact_name: "Ammari",
      origin_contact_phone: "081200000001",
      origin_address: "Jalan Contoh No. 1",
      origin_area_id: "IDNP9IDNC23IDND245IDZ40132",
      origin_collection_method: "pickup",
      destination_contact_name: "Rina Contoh",
      destination_contact_phone: "081200000002",
      destination_address: "Jalan Contoh No. 2, RT 01/RW 02, Kelurahan Contoh",
      destination_note: "Pagar hitam",
      destination_area_id: "IDNP6IDNC148IDND843IDZ12250",
      courier_company: "jne",
      courier_type: "reg",
      delivery_type: "now",
      reference_id: "DEV-ORD-202612-0001-K1",
      order_note: "ORD-202612-0001",
      items: [{ name: "Pakaian", category: "fashion", value: 538_000, quantity: 1, weight: 1_500 }],
    });
  });

  test("maps the documented answer", async () => {
    const { client } = clientWith([jsonResponse(200, BITESHIP_ORDER_CREATED)]);
    expect(await client.createShipment(bookingInput)).toEqual({
      providerOrderId: ORDER_ID,
      referenceId: "DEV-ORD-202612-0001-K1",
      providerStatus: "confirmed",
      knownStatus: "confirmed",
      status: "pickup_requested",
      waybillId: "0123082100003094",
      trackingId: "6051861741a37414e6637fab",
      routingCode: null,
      courierCode: "jne",
      serviceCode: "reg",
      price: 34_000,
      trackingLink: null,
      driver: null,
      history: [],
    });
  });

  test("a 201 is a success too", async () => {
    const { client } = clientWith([jsonResponse(201, BITESHIP_ORDER_CREATED)]);
    expect((await client.createShipment(bookingInput)).providerOrderId).toBe(ORDER_ID);
  });

  test("a waybill issued later is null now, never a guess", async () => {
    const pending = { ...BITESHIP_ORDER_CREATED, courier: { ...BITESHIP_ORDER_CREATED.courier, waybill_id: null } };
    const { client } = clientWith([jsonResponse(200, pending)]);
    expect((await client.createShipment(bookingInput)).waybillId).toBeNull();
  });

  test("40002060: duplicate reference with the existing order id, the booking exists", async () => {
    const { client } = clientWith([jsonResponse(400, BITESHIP_ORDER_DUPLICATE_REFERENCE)]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("duplicate_reference");
    expect(error.existingOrderId).toBe(ORDER_ID);
    expect(error.outcomeUnknown).toBe(true);
    expect(error.providerCode).toBe(40002060);
  });

  test("40002060 without details: duplicate, existing id unknown", async () => {
    const { details: _details, ...withoutDetails } = BITESHIP_ORDER_DUPLICATE_REFERENCE;
    const { client } = clientWith([jsonResponse(400, withoutDetails)]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("duplicate_reference");
    expect(error.existingOrderId).toBeNull();
  });

  test("40002060 with an odd id in details: the id is not trusted", async () => {
    const odd = { ...BITESHIP_ORDER_DUPLICATE_REFERENCE, details: { order_id: "../../v1/x" } };
    const { client } = clientWith([jsonResponse(400, odd)]);
    expect((await caught(client.createShipment(bookingInput))).existingOrderId).toBeNull();
  });

  test.each([400, 402, 409, 422])("a %i with Biteship's error is a refusal: nothing was booked", async (status) => {
    const { client } = clientWith([jsonResponse(status, BITESHIP_ORDER_REFUSED)]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("refused");
    expect(error.outcomeUnknown).toBe(false);
    expect(error.providerCode).toBe(40002039);
    expect(error.status).toBe(status);
  });

  test.each([401, 403, 404, 408, 425, 429])("a %i is unavailable (key, endpoint, timeout or rate limit), nothing booked", async (status) => {
    const { client } = clientWith([jsonResponse(status, BITESHIP_UNAUTHORIZED)]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("unavailable");
    expect(error.outcomeUnknown).toBe(false);
  });

  test("a 5xx may have booked: unavailable with outcomeUnknown, never retried", async () => {
    const { client, fetchStub } = clientWith([jsonResponse(502, { success: false })]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("unavailable");
    expect(error.outcomeUnknown).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("a timeout may have booked: never retried", async () => {
    const { client, fetchStub } = clientWith([timeoutError()]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("unavailable");
    expect(error.outcomeUnknown).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("a network error may have booked: never retried", async () => {
    const { client, fetchStub } = clientWith([new TypeError("fetch failed")]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.outcomeUnknown).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("40002060 sent as a numeric string is still a duplicate", async () => {
    const { client } = clientWith([jsonResponse(400, { ...BITESHIP_ORDER_DUPLICATE_REFERENCE, code: "40002060" })]);
    expect(await caught(client.createShipment(bookingInput))).toMatchObject({ reason: "duplicate_reference", existingOrderId: ORDER_ID, outcomeUnknown: true });
  });

  test("40002060 with odd other fields is still a duplicate", async () => {
    const { client } = clientWith([jsonResponse(409, { ...BITESHIP_ORDER_DUPLICATE_REFERENCE, success: "no", error: 42 })]);
    expect((await caught(client.createShipment(bookingInput))).reason).toBe("duplicate_reference");
  });

  test.each([
    ["a proxy page", new Response("<html>Bad Request</html>", { status: 400 })],
    ["an envelope without a code", jsonResponse(400, { success: false, error: "?" })],
    ["a JSON list", jsonResponse(400, [1, 2])],
  ])("a 4xx without Biteship's error format (%s) is never 'nothing booked'", async (_name, response) => {
    const { client } = clientWith([response]);
    expect(await caught(client.createShipment(bookingInput))).toMatchObject({ reason: "bad_response", outcomeUnknown: true });
  });

  test("an answer naming another reference id is a bad response; the booking may exist", async () => {
    const { client } = clientWith([jsonResponse(200, { ...BITESHIP_ORDER_CREATED, reference_id: "DEV-ORD-202612-0009-K1" })]);
    expect(await caught(client.createShipment(bookingInput))).toMatchObject({ reason: "bad_response", outcomeUnknown: true });
  });

  test("free text is cleaned to one line and capped before it is sent", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_ORDER_CREATED)]);
    await client.createShipment({
      ...bookingInput,
      destination: { ...bookingInput.destination, name: "  Rina\n\u200bContoh ", note: "x".repeat(500), address: "Jalan\tContoh" },
      orderNote: "\u0000",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.destination_contact_name).toBe("Rina Contoh");
    expect(body.destination_address).toBe("Jalan Contoh");
    expect(body.destination_note).toHaveLength(200);
    expect(body).not.toHaveProperty("order_note");
  });

  test("a required field empty after cleaning is refused before sending", async () => {
    const { client, fetchStub } = clientWith([]);
    await expect(client.createShipment({ ...bookingInput, destination: { ...bookingInput.destination, address: " \u200b " } })).rejects.toThrow(RangeError);
    await expect(client.createShipment({ ...bookingInput, referenceId: "with space" })).rejects.toThrow(RangeError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("a success we cannot read may have booked", async () => {
    const { client } = clientWith([new Response("<html>ok</html>", { status: 200 })]);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("bad_response");
    expect(error.outcomeUnknown).toBe(true);
  });

  test("the daily write budget refuses before anything is sent", async () => {
    const refuse = async () => {
      throw new ShippingRateError("budget_exhausted", "daily order_writes budget of 200 requests used up");
    };
    const { client, fetchStub } = clientWith([], refuse);
    const error = await caught(client.createShipment(bookingInput));
    expect(error.reason).toBe("budget_exhausted");
    expect(error.outcomeUnknown).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("a budget that cannot be recorded (database error) is unavailable and nothing was sent", async () => {
    const broken = async () => {
      throw new Error("connection terminated");
    };
    const { client, fetchStub } = clientWith([], broken);
    const error = await caught(client.createShipment(bookingInput));
    expect(error).toMatchObject({ reason: "unavailable", outcomeUnknown: false });
    expect((error.cause as Error).message).toBe("connection terminated");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("draws on the write budget", async () => {
    const kinds: ShipmentCallKind[] = [];
    const { client } = clientWith([jsonResponse(200, BITESHIP_ORDER_CREATED)], async (kind) => {
      kinds.push(kind);
    });
    await client.createShipment(bookingInput);
    expect(kinds).toEqual(["order_writes"]);
  });

  test("refuses an item that is not whole positive numbers before sending", async () => {
    const { client, fetchStub } = clientWith([]);
    await expect(client.createShipment({ ...bookingInput, item: { ...bookingInput.item, weightGrams: 0 } })).rejects.toThrow(RangeError);
    await expect(client.createShipment({ ...bookingInput, item: { ...bookingInput.item, value: 12.5 } })).rejects.toThrow(RangeError);
    await expect(client.createShipment({ ...bookingInput, destination: { ...bookingInput.destination, phone: "0812" } })).rejects.toThrow(RangeError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("error log fields never carry the request body", async () => {
    const { client } = clientWith([jsonResponse(400, BITESHIP_ORDER_REFUSED)]);
    const fields = JSON.stringify((await caught(client.createShipment(bookingInput))).logFields());
    expect(fields).not.toContain("Rina");
    expect(fields).not.toContain("0812");
    expect(fields).not.toContain(API_KEY);
  });
});

describe("getShipment", () => {
  test("GET /v1/orders/:id with status, waybill, routing code, price, driver, link and sorted history", async () => {
    const shuffled = { ...BITESHIP_ORDER_PICKED, courier: { ...BITESHIP_ORDER_PICKED.courier, history: [...BITESHIP_ORDER_PICKED.courier.history].reverse() } };
    const { client, calls } = clientWith([jsonResponse(200, shuffled)]);
    const order = await client.getShipment(ORDER_ID);

    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/orders/${ORDER_ID}`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(order).toMatchObject({
      providerOrderId: ORDER_ID,
      providerStatus: "picked",
      knownStatus: "picked",
      status: "picked_up",
      waybillId: "0123082100003094",
      routingCode: "BDO-JKT 12250",
      price: 41_000,
      trackingLink: "https://track.example.invalid/0123082100003094",
      driver: { name: "Budi Kurir", phone: "081200000003", plateNumber: "D 1234 AB" },
    });
    expect(order.history.map((entry) => [entry.providerStatus, entry.status, entry.occurredAt.toISOString()])).toEqual([
      ["confirmed", "pickup_requested", "2026-12-02T03:00:00.000Z"],
      ["allocated", "pickup_requested", "2026-12-02T04:30:00.000Z"],
      ["picked", "picked_up", "2026-12-02T07:05:00.000Z"],
    ]);
    expect(order.history[2]!.note).toBe("Item has been picked and ready to be shipped.");
  });

  test("camelCase statuses and unknown statuses: canonical when known, raw and unmapped otherwise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      ...BITESHIP_ORDER_PICKED,
      status: "droppingOff",
      courier: {
        ...BITESHIP_ORDER_PICKED.courier,
        history: [
          { status: "inTransit", note: "Di gudang", updated_at: "2026-12-03T08:00:00+07:00" },
          { status: "teleported", note: "?", updated_at: "2026-12-03T09:00:00+07:00" },
        ],
      },
    };
    const { client } = clientWith([jsonResponse(200, body)]);
    const order = await client.getShipment(ORDER_ID);
    expect(order).toMatchObject({ providerStatus: "droppingOff", knownStatus: "dropping_off", status: "in_transit" });
    expect(order.history.map((entry) => [entry.providerStatus, entry.status])).toEqual([
      ["in_transit", "in_transit"],
      ["teleported", null],
    ]);
  });

  test("an unknown top-level status stays raw with no state", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith([jsonResponse(200, { ...BITESHIP_ORDER_PICKED, status: "lost_in_space" })]);
    expect(await client.getShipment(ORDER_ID)).toMatchObject({ providerStatus: "lost_in_space", knownStatus: null, status: null });
  });

  test("malformed history rows are skipped and counted; notes are cleaned to one line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      ...BITESHIP_ORDER_PICKED,
      courier: {
        ...BITESHIP_ORDER_PICKED.courier,
        history: [
          { status: "picked", note: "Paket\ndijemput​  kurir", updated_at: "2026-12-02T14:05:00+07:00" },
          { status: "picked", note: "no time" },
          { status: "picked", note: "bad time", updated_at: "kemarin" },
          "not an object",
        ],
      },
    };
    const { client } = clientWith([jsonResponse(200, body)]);
    const order = await client.getShipment(ORDER_ID);
    expect(order.history).toHaveLength(1);
    expect(order.history[0]!.note).toBe("Paket dijemput kurir");
    expect(warn).toHaveBeenCalledWith("[shipping] Biteship order: skipped 3 malformed history rows");
  });

  test("odd optional fields become null instead of failing the whole answer, each one logged without its value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      success: true,
      id: ORDER_ID,
      status: "in_transit",
      price: 41000.5,
      courier: { waybill_id: "has space", link: "http://insecure.invalid/x", routing_code: 42, history: "none" },
    };
    const { client } = clientWith([jsonResponse(200, body)]);
    expect(await client.getShipment(ORDER_ID)).toMatchObject({
      status: "in_transit",
      price: null,
      waybillId: null,
      trackingLink: null,
      routingCode: null,
      history: [],
      driver: null,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("waybill_id was sent but is not a usable token");
    expect(logged).toContain("no whole rupiah price");
    expect(logged).toContain("history is not a list");
    expect(logged).not.toContain("has space");
  });

  test("a courier that is not an object, or a note that is not text, never hides the status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith([jsonResponse(200, { success: true, id: ORDER_ID, status: "picked", price: 1000, courier: "jne" })]);
    expect(await client.getShipment(ORDER_ID)).toMatchObject({ status: "picked_up", waybillId: null, history: [] });
    const withObjectNote = {
      ...BITESHIP_ORDER_PICKED,
      courier: { ...BITESHIP_ORDER_PICKED.courier, history: [{ status: "picked", note: { text: "x" }, updated_at: "2026-12-02T14:05:00+07:00" }] },
    };
    const { client: second } = clientWith([jsonResponse(200, withObjectNote)]);
    expect((await second.getShipment(ORDER_ID)).history).toMatchObject([{ providerStatus: "picked", note: "" }]);
  });

  test("a history time without an offset is WIB, never the server's local time", async () => {
    const body = { ...BITESHIP_ORDER_PICKED, courier: { ...BITESHIP_ORDER_PICKED.courier, history: [{ status: "picked", note: "", updated_at: "2026-12-02 14:05:00" }] } };
    const { client } = clientWith([jsonResponse(200, body)]);
    expect((await client.getShipment(ORDER_ID)).history[0]!.occurredAt.toISOString()).toBe("2026-12-02T07:05:00.000Z");
  });

  test("undocumented statuses are logged as sent (not personal data)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith([jsonResponse(200, { ...BITESHIP_ORDER_PICKED, status: "lost_in_space" })]);
    await client.getShipment(ORDER_ID);
    expect(warn).toHaveBeenCalledWith("[shipping] Biteship order: undocumented status", { statuses: ["lost_in_space"] });
  });

  test("an answer for another order id is a bad response", async () => {
    const { client } = clientWith([jsonResponse(200, { ...BITESHIP_ORDER_PICKED, id: "aaaaaaaaaaaaaaaaaaaaaaaa" })]);
    expect((await caught(client.getShipment(ORDER_ID))).reason).toBe("bad_response");
  });

  test("a 200 without the documented shape is a bad response", async () => {
    const { client } = clientWith([jsonResponse(200, { success: true })]);
    expect((await caught(client.getShipment(ORDER_ID))).reason).toBe("bad_response");
  });

  test("404 is not found", async () => {
    const { client } = clientWith([jsonResponse(404, { success: false, error: "Order not found", code: 40400001 })]);
    expect((await caught(client.getShipment(ORDER_ID))).reason).toBe("not_found");
  });

  test("one retry on a 5xx, then the answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, fetchStub } = clientWith([jsonResponse(503, {}), jsonResponse(200, BITESHIP_ORDER_PICKED)]);
    expect((await client.getShipment(ORDER_ID)).status).toBe("picked_up");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("one retry on a network error (logged); a second failure is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, fetchStub } = clientWith([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    expect((await caught(client.getShipment(ORDER_ID))).reason).toBe("unavailable");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("a timeout is not retried", async () => {
    const { client, fetchStub } = clientWith([timeoutError()]);
    expect((await caught(client.getShipment(ORDER_ID))).reason).toBe("unavailable");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("every attempt draws on the read budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kinds: ShipmentCallKind[] = [];
    const { client } = clientWith([jsonResponse(500, {}), jsonResponse(200, BITESHIP_ORDER_PICKED)], async (kind) => {
      kinds.push(kind);
    });
    await client.getShipment(ORDER_ID);
    expect(kinds).toEqual(["orders", "orders"]);
  });

  test("an id that does not look like Biteship's is never put in a URL, and is our own data error, not 'not found'", async () => {
    const { client, fetchStub } = clientWith([]);
    await expect(client.getShipment("../maps/areas")).rejects.toThrow(RangeError);
    await expect(client.cancelShipment("", { reasonCode: "others" })).rejects.toThrow(RangeError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("cancelShipment", () => {
  test("POST /v1/orders/:id/cancel with the reason code and text", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_ORDER_CANCELLED)]);
    const result = await client.cancelShipment(ORDER_ID, { reasonCode: "others", reason: "Dibatalkan oleh admin" });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/orders/${ORDER_ID}/cancel`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ cancellation_reason_code: "others", cancellation_reason: "Dibatalkan oleh admin" });
    expect(result).toEqual({ providerOrderId: ORDER_ID, providerStatus: "cancelled" });
  });

  test("without a reason text only the code is sent", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_ORDER_CANCELLED)]);
    await client.cancelShipment(ORDER_ID, { reasonCode: "change_courier" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ cancellation_reason_code: "change_courier" });
  });

  test("40002053: past pickup, not cancellable", async () => {
    const { client } = clientWith([jsonResponse(400, BITESHIP_ORDER_NOT_CANCELLABLE)]);
    expect((await caught(client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).reason).toBe("not_cancellable");
  });

  test.each([40002054, 40002055, 40002056])("%i (cancel failed on their side) is unavailable, worth trying again", async (code) => {
    const { client } = clientWith([jsonResponse(400, { success: false, error: "cancel failed", code })]);
    expect((await caught(client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).reason).toBe("unavailable");
  });

  test("a timeout may have cancelled: unavailable with outcomeUnknown, not retried", async () => {
    const { client, fetchStub } = clientWith([timeoutError()]);
    expect(await caught(client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).toMatchObject({ reason: "unavailable", outcomeUnknown: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("a 5xx or an unreadable 200 may have cancelled", async () => {
    expect(await caught(clientWith([jsonResponse(502, {})]).client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).toMatchObject({ reason: "unavailable", outcomeUnknown: true });
    expect(await caught(clientWith([jsonResponse(200, { ok: 1 })]).client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).toMatchObject({ reason: "bad_response", outcomeUnknown: true });
  });

  test("404 is not found; another 4xx is a refusal", async () => {
    expect((await caught(clientWith([jsonResponse(404, {})]).client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).reason).toBe("not_found");
    expect((await caught(clientWith([jsonResponse(400, { success: false, code: 40000001 })]).client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).reason).toBe("refused");
    expect(await caught(clientWith([new Response("nope", { status: 400 })]).client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).toMatchObject({ reason: "bad_response", outcomeUnknown: true });
  });

  test("an answer for another order id is a bad response", async () => {
    const { client } = clientWith([jsonResponse(200, { ...BITESHIP_ORDER_CANCELLED, id: "aaaaaaaaaaaaaaaaaaaaaaaa" })]);
    expect((await caught(client.cancelShipment(ORDER_ID, { reasonCode: "others" }))).reason).toBe("bad_response");
  });

  test("draws on the write budget", async () => {
    const kinds: ShipmentCallKind[] = [];
    const { client } = clientWith([jsonResponse(200, BITESHIP_ORDER_CANCELLED)], async (kind) => {
      kinds.push(kind);
    });
    await client.cancelShipment(ORDER_ID, { reasonCode: "others" });
    expect(kinds).toEqual(["order_writes"]);
  });
});

describe("parseBiteshipOrder", () => {
  test("requires success and an id", () => {
    expect(parseBiteshipOrder({ success: true })).toBeNull();
    expect(parseBiteshipOrder({ success: false, id: ORDER_ID })).toBeNull();
    expect(parseBiteshipOrder(null)).toBeNull();
    expect(parseBiteshipOrder({ success: true, id: ORDER_ID })).toMatchObject({ providerOrderId: ORDER_ID, status: null, history: [] });
  });
});
