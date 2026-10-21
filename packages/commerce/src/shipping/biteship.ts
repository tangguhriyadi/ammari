import "server-only";
import { z } from "zod";
import { ShippingRateError, type RatesInput, type ShippingArea, type ShippingCallKind, type ShippingRateProvider } from "./provider";
import { normalizeProviderPostalCode, type RatedService } from "./rules";

// Biteship Maps + Rates client (docs/plans/cart-checkout.md D18, §4.5.1, §4.5.4). Documented at
// https://biteship.com/id/docs (read 2026-10-21):
// - host `https://api.biteship.com`, header `authorization: <API key>` (the raw key: the docs'
//   only example sends it without `Bearer`/`Basic`), JSON; test and live mode share the host and
//   are told apart by the key (`biteship_test.` / `biteship_live.`). Test-mode Maps and Rates
//   return real data and are billed.
// - `GET /v1/maps/areas?countries=ID&input=<text>&type=single` -> `{ success, areas: [{ id, name,
//   administrative_division_level_1_name (province), _2_ (city), _3_ (kecamatan), postal_code }] }`.
//   Ids are kecamatan + kode pos; there is no kelurahan level. No limit parameter.
// - `POST /v1/rates/couriers` with `origin_area_id`, `destination_area_id`, `couriers`
//   ("jne,jnt"), `items[]` (`name`, `value`, `weight` in grams, `quantity`) -> `{ success,
//   pricing: [{ courier_code, courier_service_code, price, ... }] }`; `price` is final (fee plus
//   surcharge minus discount, plus insurance/COD only when requested, which we never do).
// - errors are `{ success: false, error, code }`; 40001010 "No courier available for requested
//   location" (HTTP 400) means no service. Request-rate limits answer 429 (help center).
// The same area ids go into `POST /v1/orders` in Phase K ("Use area_id from Maps API").

export const BITESHIP_TIMEOUT_MS = 5_000;
export const BITESHIP_RETRY_DELAY_MS = 300;
/** Biteship's "No courier available for requested location" (rates error table). */
export const BITESHIP_NO_COURIER_CODE = 40001010;

export interface BiteshipClientOptions {
  apiKey: string;
  /** `BITESHIP_BASE_URL`. Always our own configuration, never user input (no SSRF). */
  baseUrl: string;
  /** Called before every HTTP attempt, retries included; throws to refuse (the daily budgets). */
  beforeRequest?: (kind: ShippingCallKind) => Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const envelope = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
  code: z.number().optional(),
});

const nameSchema = z.string().trim().min(1).max(200);

const areaRow = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
  administrative_division_level_1_name: nameSchema,
  administrative_division_level_2_name: nameSchema,
  administrative_division_level_3_name: nameSchema,
  postal_code: z.union([z.number(), z.string()]).nullish(),
});

const pricingRow = z.object({
  courier_code: z.string().trim().min(1).max(50),
  courier_service_code: z.string().trim().min(1).max(100),
  // Whole rupiah in every documented example; pickCheapestService refuses anything else.
  price: z.number(),
});

function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBiteshipClient(options: BiteshipClientOptions): ShippingRateProvider {
  const timeoutMs = options.timeoutMs ?? BITESHIP_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? BITESHIP_RETRY_DELAY_MS;

  /** One request with one retry after `retryDelayMs`, on network errors and 5xx only. A timeout
   * is not retried: the buyer has already waited `timeoutMs`. Returns the status and the parsed
   * JSON body (null when it is not JSON). */
  async function request(kind: ShippingCallKind, url: URL, init: RequestInit): Promise<{ status: number; json: unknown; isJson: boolean }> {
    for (let attempt = 1; ; attempt += 1) {
      await options.beforeRequest?.(kind);
      let response: Response;
      try {
        // Looked up per request, not captured at construction, so a stub installed later (tests)
        // is always the one used.
        response = await (options.fetch ?? globalThis.fetch)(url, {
          ...init,
          headers: { ...init.headers, authorization: options.apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (!timedOut && attempt === 1) {
          await delay(retryDelayMs);
          continue;
        }
        throw new ShippingRateError("unavailable", timedOut ? `Biteship ${kind} request timed out` : `Biteship ${kind} request failed`, {
          cause: error,
        });
      }
      if (response.status >= 500 && attempt === 1) {
        console.warn(`[shipping] Biteship ${kind} answered ${response.status}; retrying once`);
        await response.body?.cancel();
        await delay(retryDelayMs);
        continue;
      }
      let json: unknown = null;
      let isJson = true;
      try {
        json = await response.json();
      } catch {
        isJson = false;
      }
      return { status: response.status, json, isJson };
    }
  }

  /** Any non-200 answer we have not mapped to "no results": the key, balance, plan or our request
   * is wrong, or Biteship is overloaded. The buyer sees the same message as an outage (§4.5.5);
   * the status and Biteship code go to the log. */
  function failFor(kind: ShippingCallKind, status: number, json: unknown): never {
    const parsed = envelope.safeParse(json);
    const providerCode = parsed.success ? parsed.data.code : undefined;
    throw new ShippingRateError("unavailable", `Biteship ${kind} answered ${status}`, { status, providerCode });
  }

  return {
    name: "biteship",

    async searchAreas(query: string): Promise<ShippingArea[]> {
      const url = joinUrl(options.baseUrl, "v1/maps/areas");
      url.searchParams.set("countries", "ID");
      url.searchParams.set("input", query);
      url.searchParams.set("type", "single");
      // No documented "not found" status for Maps (an empty `areas` list is the empty answer), so a
      // 404 is a wrong base URL or a moved endpoint: unavailable, never a silent "no results".
      const { status, json, isJson } = await request("maps", url, { method: "GET" });
      if (status !== 200) failFor("maps", status, json);
      const body = z.object({ success: z.literal(true), areas: z.array(z.unknown()) }).safeParse(json);
      if (!body.success) {
        throw new ShippingRateError("bad_response", `Biteship maps answered 200 ${isJson ? "without a list of areas" : "with a non-JSON body"}`, { status });
      }

      const areas: ShippingArea[] = [];
      let skipped = 0;
      let firstIssue: { path: PropertyKey[]; code: string } | undefined;
      for (const raw of body.data.areas) {
        const row = areaRow.safeParse(raw);
        if (!row.success) {
          skipped += 1;
          const issue = row.error.issues[0];
          if (!firstIssue && issue) firstIssue = { path: issue.path, code: issue.code };
          continue;
        }
        areas.push({
          providerAreaId: row.data.id,
          province: row.data.administrative_division_level_1_name,
          city: row.data.administrative_division_level_2_name,
          district: row.data.administrative_division_level_3_name,
          subdistrict: null,
          postalCode: normalizeProviderPostalCode(row.data.postal_code),
        });
      }
      if (skipped > 0 && areas.length === 0) {
        throw new ShippingRateError("bad_response", `Biteship maps: all ${skipped} areas malformed`, { status });
      }
      // The count and the first issue's path and code (never values, the query text or the key),
      // so a partial shape change is diagnosable.
      if (skipped > 0) console.warn(`[shipping] Biteship maps: skipped ${skipped} malformed areas`, { firstIssue });
      return areas;
    },

    async quoteRates(input: RatesInput): Promise<RatedService[]> {
      const url = joinUrl(options.baseUrl, "v1/rates/couriers");
      const { status, json, isJson } = await request("rates", url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin_area_id: input.originAreaId,
          destination_area_id: input.destinationAreaId,
          couriers: input.courierCodes.join(","),
          // One item for the whole parcel (plan §4.5.3): the courier prices the weight, and the
          // item name and value never identify the buyer.
          items: [{ name: "Pakaian", category: "fashion", value: input.goodsValue, weight: input.weightGrams, quantity: 1 }],
        }),
      });
      if (status !== 200) {
        // The documented "no courier for this location" is the one non-200 that means "no service".
        const error = envelope.safeParse(json);
        if (status === 400 && error.success && error.data.code === BITESHIP_NO_COURIER_CODE) {
          console.info("[shipping] Biteship rates: no courier for the location", { status, providerCode: BITESHIP_NO_COURIER_CODE });
          return [];
        }
        failFor("rates", status, json);
      }
      const body = z.object({ success: z.literal(true), pricing: z.array(z.unknown()) }).safeParse(json);
      if (!body.success) {
        throw new ShippingRateError("bad_response", `Biteship rates answered 200 ${isJson ? "with an unexpected shape" : "with a non-JSON body"}`, { status });
      }
      // Row by row, like the areas: one odd courier row must not throw away every other price.
      const services: RatedService[] = [];
      let skipped = 0;
      for (const raw of body.data.pricing) {
        const row = pricingRow.safeParse(raw);
        if (!row.success) {
          skipped += 1;
          continue;
        }
        services.push({ courierCode: row.data.courier_code, serviceCode: row.data.courier_service_code, cost: row.data.price });
      }
      if (skipped > 0 && services.length === 0) {
        throw new ShippingRateError("bad_response", `Biteship rates: all ${skipped} pricing rows malformed`, { status });
      }
      if (skipped > 0) console.warn(`[shipping] Biteship rates: skipped ${skipped} malformed pricing rows`);
      return services;
    },
  };
}
