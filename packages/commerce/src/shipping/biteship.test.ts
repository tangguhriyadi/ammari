import { describe, expect, test, vi } from "vitest";
import { createBiteshipClient } from "./biteship";
import {
  BITESHIP_AREAS_EMPTY,
  BITESHIP_AREAS_OK,
  BITESHIP_RATES_NO_COURIER,
  BITESHIP_RATES_OK,
  BITESHIP_UNAUTHORIZED,
} from "./biteship-fixtures";
import { ShippingRateError } from "./provider";
import type { ShippingCallKind } from "./provider";

// docs/plans/cart-checkout.md §4.5.4, session 8: the Biteship client against hand-written fixtures
// through a stub fetch. Nothing here reaches the network.

const API_KEY = "biteship_test.not-a-real-key";
const BASE_URL = "https://biteship.invalid";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(responses: Array<Response | Error>, beforeRequest?: (kind: ShippingCallKind) => Promise<void>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = vi.fn(async (url: URL | Request | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const client = createBiteshipClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetch: fetchStub as unknown as typeof fetch,
    retryDelayMs: 1,
    beforeRequest,
  });
  return { client, calls, fetchStub };
}

const ratesInput = {
  originAreaId: "IDNP9IDNC23IDND245IDZ40132",
  destinationAreaId: "IDNP6IDNC148IDND843IDZ12250",
  weightGrams: 1_500,
  goodsValue: 538_000,
  courierCodes: ["jne", "sicepat"],
};

async function expectRateError(promise: Promise<unknown>, reason: string, status?: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ShippingRateError);
  expect((error as ShippingRateError).reason).toBe(reason);
  if (status !== undefined) expect((error as ShippingRateError).status).toBe(status);
  return error as ShippingRateError;
}

describe("searchAreas", () => {
  test("sends the documented request with the raw key and maps the documented areas", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_AREAS_OK)]);
    const areas = await client.searchAreas("pesanggrahan");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE_URL}/v1/maps/areas`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ countries: "ID", input: "pesanggrahan", type: "single" });
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(API_KEY);
    expect(calls[0]!.init.redirect).toBe("error");

    expect(areas).toEqual([
      {
        providerAreaId: "IDNP6IDNC148IDND843IDZ12250",
        province: "DKI Jakarta",
        city: "Jakarta Selatan",
        district: "Pesanggrahan",
        subdistrict: null,
        postalCode: "12250",
      },
      {
        providerAreaId: "IDNP6IDNC148IDND843IDZ12260",
        province: "DKI Jakarta",
        city: "Jakarta Selatan",
        district: "Pesanggrahan",
        subdistrict: null,
        postalCode: "12260",
      },
    ]);
  });

  test("a base URL with or without a trailing slash builds the same path", async () => {
    const { calls, fetchStub } = clientWith([jsonResponse(200, BITESHIP_AREAS_EMPTY)]);
    const client = createBiteshipClient({ apiKey: API_KEY, baseUrl: `${BASE_URL}/`, fetch: fetchStub as unknown as typeof fetch });
    await client.searchAreas("abc");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/maps/areas");
  });

  test("no match: an empty list", async () => {
    expect(await clientWith([jsonResponse(200, BITESHIP_AREAS_EMPTY)]).client.searchAreas("zzz")).toEqual([]);
  });

  test("a 404 is a wrong URL or a moved endpoint: unavailable, never a silent empty list", async () => {
    await expectRateError(clientWith([jsonResponse(404, { success: false, error: "Not found" })]).client.searchAreas("zzz"), "unavailable", 404);
  });

  test("a kode pos that is not five digits is stored as null", async () => {
    const area = { ...BITESHIP_AREAS_OK.areas[0], postal_code: 0 };
    const { client } = clientWith([jsonResponse(200, { success: true, areas: [area] })]);
    expect((await client.searchAreas("abc"))[0]?.postalCode).toBeNull();
  });

  test("malformed rows are skipped and counted; all malformed is a bad response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { ...BITESHIP_AREAS_OK.areas[0], administrative_division_level_3_name: "" };
    const { client } = clientWith([jsonResponse(200, { success: true, areas: [broken, BITESHIP_AREAS_OK.areas[1]] })]);
    expect(await client.searchAreas("abc")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("[shipping] Biteship maps: skipped 1 malformed areas", {
      firstIssue: { path: ["administrative_division_level_3_name"], code: "too_small" },
    });
    warn.mockRestore();

    await expectRateError(clientWith([jsonResponse(200, { success: true, areas: [broken] })]).client.searchAreas("abc"), "bad_response");
    await expectRateError(clientWith([jsonResponse(200, { success: true, areas: "x" })]).client.searchAreas("abc"), "bad_response");
    const html = await expectRateError(clientWith([new Response("<html>", { status: 200 })]).client.searchAreas("abc"), "bad_response");
    expect(html.message).toBe("Biteship maps answered 200 with a non-JSON body");
  });

  test.each([401, 402, 403, 429, 400])("HTTP %i is unavailable, carrying the status and Biteship code", async (status) => {
    const error = await expectRateError(
      clientWith([jsonResponse(status, BITESHIP_UNAUTHORIZED)]).client.searchAreas("abc"),
      "unavailable",
      status,
    );
    expect(error.providerCode).toBe(40101001);
    expect(error.message).not.toContain(API_KEY);
  });
});

describe("quoteRates", () => {
  test("sends one documented Rates request and returns every priced service", async () => {
    const { client, calls } = clientWith([jsonResponse(200, BITESHIP_RATES_OK)]);
    const services = await client.quoteRates(ratesInput);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/rates/couriers`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(API_KEY);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      origin_area_id: "IDNP9IDNC23IDND245IDZ40132",
      destination_area_id: "IDNP6IDNC148IDND843IDZ12250",
      couriers: "jne,sicepat",
      items: [{ name: "Pakaian", category: "fashion", value: 538_000, weight: 1_500, quantity: 1 }],
    });

    expect(services).toEqual([
      { courierCode: "sicepat", serviceCode: "reg", cost: 35_000 },
      { courierCode: "jne", serviceCode: "reg", cost: 34_000 },
      { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
    ]);
  });

  test("40001010 (no courier for the location) on a 400 is no service, not an error", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await clientWith([jsonResponse(400, BITESHIP_RATES_NO_COURIER)]).client.quoteRates(ratesInput)).toEqual([]);
    expect(info).toHaveBeenCalledWith("[shipping] Biteship rates: no courier for the location", { status: 400, providerCode: 40001010 });
    expect(await clientWith([jsonResponse(200, { success: true, pricing: [] })]).client.quoteRates(ratesInput)).toEqual([]);
    info.mockRestore();
  });

  test("the no-courier code on any other status is not trusted", async () => {
    await expectRateError(clientWith([jsonResponse(200, BITESHIP_RATES_NO_COURIER)]).client.quoteRates(ratesInput), "bad_response");
    await expectRateError(clientWith([jsonResponse(403, BITESHIP_RATES_NO_COURIER)]).client.quoteRates(ratesInput), "unavailable", 403);
  });

  test("one malformed pricing row is skipped; the other prices stay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pricing = [{ courier_code: "jne", courier_service_code: "reg", price: null }, { courier_code: "jnt", courier_service_code: "ez", price: 18_000 }];
    expect(await clientWith([jsonResponse(200, { success: true, pricing })]).client.quoteRates(ratesInput)).toEqual([
      { courierCode: "jnt", serviceCode: "ez", cost: 18_000 },
    ]);
    expect(warn).toHaveBeenCalledWith("[shipping] Biteship rates: skipped 1 malformed pricing rows");
    warn.mockRestore();
  });

  test("any other 4xx is unavailable", async () => {
    const error = await expectRateError(
      clientWith([jsonResponse(400, { success: false, error: "Required parameter is missing", code: 40001002 })]).client.quoteRates(ratesInput),
      "unavailable",
      400,
    );
    expect(error.providerCode).toBe(40001002);
  });

  test("a pricing row without a numeric price is a bad response", async () => {
    const pricing = [{ courier_code: "jne", courier_service_code: "reg", price: "abc" }];
    await expectRateError(clientWith([jsonResponse(200, { success: true, pricing })]).client.quoteRates(ratesInput), "bad_response");
  });
});

describe("retries, timeouts and the budget hook", () => {
  test("one retry after a 5xx, then success", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = clientWith([jsonResponse(503, {}), jsonResponse(200, BITESHIP_RATES_OK)]);
    expect(await client.quoteRates(ratesInput)).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  test("two 5xx in a row: unavailable with the last status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = clientWith([jsonResponse(500, {}), jsonResponse(502, {})]);
    await expectRateError(client.quoteRates(ratesInput), "unavailable", 502);
    expect(calls).toHaveLength(2);
  });

  test("one retry after a network error; two network errors are unavailable, keeping the cause", async () => {
    const ok = clientWith([new TypeError("fetch failed"), jsonResponse(200, BITESHIP_AREAS_OK)]);
    expect(await ok.client.searchAreas("abc")).toHaveLength(2);
    expect(ok.calls).toHaveLength(2);

    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const down = clientWith([new TypeError("fetch failed"), cause]);
    const error = await expectRateError(down.client.searchAreas("abc"), "unavailable");
    expect(error.cause).toBe(cause);
    expect(error.logFields()).toEqual({
      reason: "unavailable",
      status: undefined,
      providerCode: undefined,
      message: "Biteship maps request failed",
      cause: { name: "TypeError", code: "ECONNRESET" },
    });
    expect(down.calls).toHaveLength(2);
  });

  test("a timeout is not retried", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { client, calls } = clientWith([timeout]);
    const error = await expectRateError(client.quoteRates(ratesInput), "unavailable");
    expect(error.message).toBe("Biteship rates request timed out");
    expect(calls).toHaveLength(1);
  });

  test("4xx answers are never retried", async () => {
    const { client, calls } = clientWith([jsonResponse(429, {})]);
    await expectRateError(client.searchAreas("abc"), "unavailable", 429);
    expect(calls).toHaveLength(1);
  });

  test("the budget hook runs before every attempt with its kind, and its refusal stops the request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kinds: ShippingCallKind[] = [];
    const counting = clientWith([jsonResponse(503, {}), jsonResponse(200, BITESHIP_RATES_OK)], async (kind) => {
      kinds.push(kind);
    });
    await counting.client.quoteRates(ratesInput);
    expect(kinds).toEqual(["rates", "rates"]);

    const refused = clientWith([], async () => {
      throw new ShippingRateError("budget_exhausted", "daily maps budget used up");
    });
    await expectRateError(refused.client.searchAreas("abc"), "budget_exhausted");
    expect(refused.fetchStub).not.toHaveBeenCalled();
  });
});
