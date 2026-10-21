import { ShippingRateError, searchShippingAreas } from "@ammari/commerce/shipping";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import {
  AREA_SEARCH_LIMIT,
  AREA_SEARCH_MAX_LENGTH,
  AREA_SEARCH_MIN_LENGTH,
  AREA_SEARCH_RATE_LIMITED_MESSAGE,
  AREA_SEARCH_TOO_LONG_MESSAGE,
  AREA_SEARCH_TOO_SHORT_MESSAGE,
  AREA_SEARCH_UNAVAILABLE_MESSAGE,
  AREA_SEARCH_WINDOW_SECONDS,
  SHIPPING_GENERIC_ERROR_MESSAGE,
} from "@/lib/shipping/messages";
import { readAreaSearchCache, writeAreaSearchCache } from "@/lib/shipping/area-search-cache";
import { getShippingRuntime } from "@/lib/shipping/runtime";

// The checkout area combobox (docs/plans/cart-checkout.md §4.5.1, session 8):
// `GET /api/shipping/areas?q=<kecamatan, city or kode pos>`. A route handler rather than a server
// action: the installed Next docs say Server Functions are for mutations and are dispatched one
// at a time, while a debounced search must be able to abort a stale request. Answers
// `{ areas: [{ id, label, hasPostalCode }] }` with our own shipping_areas ids only, or
// `{ error }` with an Indonesian message. Flag off: 404, like `/cart`.
//
// It writes (rate-limit rows, the area upsert) on a GET, so it refuses cross-site requests: a
// browser marks every fetch with Sec-Fetch-Site, and another site must not be able to spend the
// provider budget through its visitors. Never stored by an HTTP cache (private, no-store); repeated
// queries are remembered in process memory only (lib/shipping/area-search-cache.ts).

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function errorResponse(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/** Trims, collapses whitespace and drops control and invisible format characters. */
function cleanQuery(raw: string | null): string {
  return (raw ?? "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(request: Request): Promise<Response> {
  if (!isCartEnabled()) return new Response(null, { status: 404, headers: NO_STORE });

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return errorResponse(403, SHIPPING_GENERIC_ERROR_MESSAGE);
  }

  const query = cleanQuery(new URL(request.url).searchParams.get("q"));
  if (query.length < AREA_SEARCH_MIN_LENGTH) return errorResponse(400, AREA_SEARCH_TOO_SHORT_MESSAGE);
  if (query.length > AREA_SEARCH_MAX_LENGTH) return errorResponse(400, AREA_SEARCH_TOO_LONG_MESSAGE);

  try {
    const ip = await getCartClientIp("area search");
    if (!ip) return errorResponse(500, SHIPPING_GENERIC_ERROR_MESSAGE);
    const prior = await recordClaimAttemptAndCount(defaultDb, ip, "area_search", AREA_SEARCH_WINDOW_SECONDS);
    if (prior >= AREA_SEARCH_LIMIT) {
      return errorResponse(429, AREA_SEARCH_RATE_LIMITED_MESSAGE, { "Retry-After": String(AREA_SEARCH_WINDOW_SECONDS) });
    }

    const runtime = getShippingRuntime();
    if (!runtime) return errorResponse(503, AREA_SEARCH_UNAVAILABLE_MESSAGE);

    // A repeated query is answered from memory, so it spends no provider budget (lib/shipping/
    // area-search-cache.ts). Still behind the per-IP limit above.
    const cached = readAreaSearchCache(query);
    if (cached) return Response.json({ areas: cached }, { headers: NO_STORE });
    const areas = await searchShippingAreas(defaultDb, runtime.provider, query);
    writeAreaSearchCache(query, areas);
    return Response.json({ areas }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ShippingRateError) {
      // The typed reason, HTTP status and provider code only: never the query, a key or a body.
      console.error(`[shipping] area search failed: ${error.reason}`, error.logFields());
      return errorResponse(503, AREA_SEARCH_UNAVAILABLE_MESSAGE);
    }
    // Name and Postgres code only: a database error's message can carry the query's parameters
    // (the client address of the rate-limit insert).
    console.error("[shipping] area search failed", {
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined,
    });
    return errorResponse(500, SHIPPING_GENERIC_ERROR_MESSAGE);
  }
}
