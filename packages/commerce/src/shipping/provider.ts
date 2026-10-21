// The shipping rate seam (docs/plans/cart-checkout.md D17, D18, §4.5.4): Biteship in production,
// FakeShippingRateProvider in tests and e2e. Nothing outside this package talks to the provider,
// and nothing here ever receives a buyer's name, phone or street: only a search fragment, area
// ids, a parcel weight and the goods value.
import type { RatedService } from "./rules";

/** Typed failure of a rate provider call (plan §4.5.4). `unavailable`: network, timeout, 5xx,
 * 429, a key/balance/config problem (401, 402, 403) or another 4xx we do not recognize;
 * `bad_response`: the body did not have the documented shape; `budget_exhausted`: our own daily
 * call budget refused the call before it was sent. Every one of them means "Ongkir belum bisa
 * dihitung" to the buyer (§4.5.5); "no service to this destination" is not an error, it is an
 * empty service list. */
export type ShippingRateErrorReason = "unavailable" | "bad_response" | "budget_exhausted";

export interface ShippingRateErrorDetails {
  /** HTTP status when the provider answered, for the log. Never the body or the key. */
  status?: number;
  /** The provider's own error code when it sent one (Biteship `code`, e.g. 40101001). */
  providerCode?: number;
  /** The underlying error (a network failure, say). Log only its name and code: see `logFields`. */
  cause?: unknown;
}

export class ShippingRateError extends Error {
  readonly reason: ShippingRateErrorReason;
  readonly status: number | undefined;
  readonly providerCode: number | undefined;

  constructor(reason: ShippingRateErrorReason, message: string, details: ShippingRateErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ShippingRateError";
    this.reason = reason;
    this.status = details.status;
    this.providerCode = details.providerCode;
  }

  /** What is safe to log about this error: reason, status, provider code, message (always our own
   * constant text) and the cause's name and code only (never a URL, header or body). */
  logFields(): Record<string, unknown> {
    const cause = this.cause;
    const causeSummary =
      cause instanceof Error
        ? { name: cause.name, code: (cause as { code?: unknown }).code ?? (cause.cause as { code?: unknown } | undefined)?.code }
        : undefined;
    return { reason: this.reason, status: this.status, providerCode: this.providerCode, message: this.message, cause: causeSummary };
  }
}

/** Which daily budget a provider request draws on (plan §4.5.4: Biteship Maps and Rates have
 * separate quotas). */
export type ShippingCallKind = "maps" | "rates";

/** One provider area (Biteship: a kecamatan with one kode pos), as cached in `shipping_areas`. */
export interface ShippingArea {
  providerAreaId: string;
  province: string;
  city: string;
  district: string;
  /** Kelurahan. Always null with Biteship (its areas stop at kecamatan). */
  subdistrict: string | null;
  /** Already normalized: a 5-digit kode pos or null (`normalizeProviderPostalCode`). */
  postalCode: string | null;
}

export interface RatesInput {
  originAreaId: string;
  destinationAreaId: string;
  /** The whole parcel, packaging included (`parcelWeightGrams`). */
  weightGrams: number;
  /** Goods value in whole rupiah (Biteship requires an item value; without insurance or COD it does
   * not change the price). */
  goodsValue: number;
  /** Provider courier codes for one call (`allowlistCourierCodes()`). */
  courierCodes: readonly string[];
}

export interface ShippingRateProvider {
  readonly name: "biteship" | "fake";
  /** Areas matching a kecamatan, city or kode pos fragment, in the provider's order. Empty when
   * none. */
  searchAreas(query: string): Promise<ShippingArea[]>;
  /** Every service the couriers offer for this parcel. Empty when none serves the destination. */
  quoteRates(input: RatesInput): Promise<RatedService[]>;
}
