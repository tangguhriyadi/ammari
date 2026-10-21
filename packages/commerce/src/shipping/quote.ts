import "server-only";
import { eq, inArray } from "drizzle-orm";
import { products, productVariants } from "@ammari/db/schema";
import type { Database } from "../db";
import { loadShippingArea } from "./areas";
import { allowlistServicesKey, readCachedRates, writeCachedRates, type RateCacheKey } from "./cache";
import { ShippingRateError, type ShippingRateErrorReason, type ShippingRateProvider } from "./provider";
import {
  SHIPPING_SERVICE_ALLOWLIST,
  allowlistCourierCodes,
  allowlistedServices,
  parcelWeightGrams,
  pickCheapestService,
  splitShippingCost,
  type AllowlistedService,
  type RatedService,
} from "./rules";

// quoteShipping (docs/plans/cart-checkout.md §4.5.4, D17): the one server-side quote, used by
// checkout's quote action (session 10) and by placeOrder before its transaction (session 9). Never
// inside a DB transaction (it may call the provider), never trusting a browser figure. Database
// errors (other than the cache write) propagate: callers turn them into "Ongkir belum bisa
// dihitung" like any other refusal (§4.5.5). Concurrent misses for one key each call the provider;
// every call is budgeted, so no stampede lock.

export interface QuoteLine {
  sku: string;
  qty: number;
}

export interface ShippingQuoteDeps {
  provider: ShippingRateProvider;
  /** Ammari's own provider area id (`BITESHIP_ORIGIN_AREA_ID`). */
  originAreaId: string;
  /** SHIPPING_QUOTE_CACHE_MINUTES. */
  cacheMinutes: number;
  allowlist?: readonly AllowlistedService[];
}

export interface ShippingQuote {
  courierCode: string;
  serviceCode: string;
  /** e.g. "JNE Reguler". */
  label: string;
  costAmount: number;
  subsidyAmount: number;
  /** The buyer's "Ongkir" (`orders.shipping_amount`). */
  buyerAmount: number;
  weightGrams: number;
  /** The provider area id (`orders.shipping_destination_id`). */
  destinationId: string;
  /** When the price was fetched from the provider (the cache row's time on a hit). */
  quotedAt: Date;
}

/** Typed refusals (plan §4.5.4, §4.5.5). `unknown_area`: the id is not one of our areas (or has no
 * provider id); `missing_weight`: a product without `shipping_weight_grams` (or a SKU that does
 * not exist), named in `missingSkus`; `empty`: no lines; `no_service`: no allowlisted service to the
 * destination; the rest come from the provider. */
export type ShippingQuoteRefusal = "unknown_area" | "missing_weight" | "empty" | "no_service" | ShippingRateErrorReason;

export type QuoteShippingResult =
  | { ok: true; quote: ShippingQuote }
  | { ok: false; reason: ShippingQuoteRefusal; missingSkus?: string[] };

function assertLines(lines: readonly QuoteLine[]): void {
  for (const line of lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw new RangeError(`line quantity must be a positive integer, got ${line.qty}`);
  }
}

/** Weight per SKU and the goods value, from the current product rows (base_price is the public
 * price; nothing cost-related is read). */
async function loadLineFacts(db: Database, lines: readonly QuoteLine[]) {
  const skus = [...new Set(lines.map((line) => line.sku))];
  const rows = await db
    .select({ sku: productVariants.sku, weightGrams: products.shippingWeightGrams, basePrice: products.basePrice })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.sku, skus));
  return new Map(rows.map((row) => [row.sku, row]));
}

/** Quotes the cheapest allowlisted service for these cart lines to this area, from the cache
 * when fresh, otherwise with one provider Rates call that refreshes the cache. Every refusal is
 * logged with its typed reason (never an address, a key or a token); provider and database errors
 * other than ShippingRateError propagate. */
export async function quoteShipping(
  db: Database,
  deps: ShippingQuoteDeps,
  input: { areaId: string; lines: readonly QuoteLine[] },
): Promise<QuoteShippingResult> {
  const allowlist = deps.allowlist ?? SHIPPING_SERVICE_ALLOWLIST;
  assertLines(input.lines);
  if (input.lines.length === 0) return { ok: false, reason: "empty" };

  const area = await loadShippingArea(db, input.areaId);
  if (!area || !area.providerAreaId) {
    // Our own uuid only (never an address). A row without a provider id is a data gap worth seeing.
    console.warn("[shipping] quote refused: unknown_area", { areaId: input.areaId.slice(0, 64), rowExists: area !== null });
    return { ok: false, reason: "unknown_area" };
  }

  const facts = await loadLineFacts(db, input.lines);
  const weight = parcelWeightGrams(
    input.lines.map((line) => ({ sku: line.sku, qty: line.qty, weightGrams: facts.get(line.sku)?.weightGrams ?? null })),
  );
  if (!weight.ok) {
    if (weight.reason === "missing_weight") {
      // Plan §4.5.5: the SKUs go to the error log so the owner can fill "Berat kirim".
      console.error("[shipping] quote refused: product without a shipping weight", { skus: weight.missingSkus });
    }
    return { ok: false, reason: weight.reason, missingSkus: weight.missingSkus };
  }
  // Every SKU has a row here (a missing one was refused as missing_weight above). Biteship needs a
  // whole-rupiah item value; a non-integer sum is a bug, never sent.
  const goodsValue = input.lines.reduce((sum, line) => sum + line.qty * (facts.get(line.sku)?.basePrice ?? 0), 0);
  if (!Number.isSafeInteger(goodsValue) || goodsValue < 0) throw new RangeError(`goods value must be whole rupiah, got ${goodsValue}`);

  const key: RateCacheKey = {
    originId: deps.originAreaId,
    destinationId: area.providerAreaId,
    weightGrams: weight.grams,
    servicesKey: allowlistServicesKey(allowlist),
  };

  let services: RatedService[];
  let fetchedAt: Date;
  const cached = await readCachedRates(db, key, deps.cacheMinutes);
  if (cached) {
    services = cached.services;
    fetchedAt = cached.fetchedAt;
  } else {
    let answered: RatedService[];
    try {
      answered = await deps.provider.quoteRates({
        originAreaId: key.originId,
        destinationAreaId: key.destinationId,
        weightGrams: key.weightGrams,
        goodsValue,
        courierCodes: allowlistCourierCodes(allowlist),
      });
    } catch (error) {
      if (!(error instanceof ShippingRateError)) throw error;
      console.error(`[shipping] quote refused: ${error.reason}`, { provider: deps.provider.name, ...error.logFields() });
      return { ok: false, reason: error.reason };
    }
    services = allowlistedServices(answered, allowlist);
    if (answered.length > 0 && services.length === 0) {
      // The provider priced services, but none survived the allowlist and price checks: a renamed
      // service code or a malformed price looks exactly like "no courier" to the buyer. Logged
      // loudly with the codes (public data, no prices), and NOT cached, so a fix takes effect at once.
      console.error("[shipping] quote: every service the provider returned was filtered out", {
        provider: deps.provider.name,
        returned: answered.map((service) => `${service.courierCode}:${service.serviceCode}`),
      });
      fetchedAt = new Date();
    } else {
      try {
        fetchedAt = await writeCachedRates(db, key, services);
      } catch (error) {
        // The cache is an optimisation: a failed write must not throw away a quote already paid for.
        console.error("[shipping] rate cache write failed; using the fresh quote uncached", error instanceof Error ? error.name : "unknown");
        fetchedAt = new Date();
      }
    }
  }

  const picked = pickCheapestService(services, allowlist);
  if (!picked) {
    console.warn("[shipping] quote refused: no_service", { provider: deps.provider.name, destinationId: key.destinationId });
    return { ok: false, reason: "no_service" };
  }
  const split = splitShippingCost(picked.cost);
  return {
    ok: true,
    quote: {
      courierCode: picked.courierCode,
      serviceCode: picked.serviceCode,
      label: picked.label,
      ...split,
      weightGrams: weight.grams,
      destinationId: key.destinationId,
      quotedAt: fetchedAt,
    },
  };
}
