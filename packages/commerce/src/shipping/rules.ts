// @ammari/commerce/shipping-rules (docs/plans/cart-checkout.md §4.5, D11, decisions 17 to 19):
// the subsidy split, the parcel weight, the courier allowlist and the cheapest-service pick. Pure,
// with no server-only import and no DB, so the checkout UI (session 10) can import the same rules
// and constants. The server-side quote lives in ./index.ts (@ammari/commerce/shipping).
import { SHIPPING_PACKAGING_GRAMS, SHIPPING_SUBSIDY_MAX_AMOUNT } from "./constants";

export { SHIPPING_PACKAGING_GRAMS, SHIPPING_SUBSIDY_MAX_AMOUNT };

export interface AllowlistedService {
  /** Biteship `courier_code`, lowercase (e.g. `jne`); its order API's `courier_company`. Stored on
   * the order. */
  readonly courierCode: string;
  /** Biteship `courier_service_code` (e.g. `reg`); its order API's `courier_type`. Stored on the
   * order. */
  readonly serviceCode: string;
  /** Shown to the buyer in checkout section 3 and to staff (e.g. "JNE Reguler"). */
  readonly label: string;
}

/** Regular, non-COD, non-instant, non-cargo services only (decision 18). The order is the
 * tie-break: equal prices pick the earlier entry, so the same inputs always give the same service.
 *
 * Codes as Biteship's courier list documents them (https://biteship.com/id/docs/api/couriers/
 * overview, checked 2026-10-21; the shipping provider since plan D18). POS has no "reguler" code
 * there: `kilat_khusus` (Pos Kilat Khusus) is its regular parcel service, kept because POS covers
 * remote destinations. A code that differs from what Biteship really returns simply never matches,
 * so it can only make the pick narrower, never wrong; the opt-in contract test prints the codes a
 * real key returns. Six couriers fit the Grow plan's 10 active couriers; on Starter (3 active)
 * only the activated ones answer. Changing this list changes the cache key (./cache.ts), so old
 * cached quotes are never reused. */
export const SHIPPING_SERVICE_ALLOWLIST: readonly AllowlistedService[] = [
  { courierCode: "jne", serviceCode: "reg", label: "JNE Reguler" },
  { courierCode: "jnt", serviceCode: "ez", label: "J&T Reguler" },
  { courierCode: "sicepat", serviceCode: "reg", label: "SiCepat Reguler" },
  { courierCode: "idexpress", serviceCode: "reg", label: "ID Express Reguler" },
  { courierCode: "anteraja", serviceCode: "reg", label: "AnterAja Reguler" },
  { courierCode: "pos", serviceCode: "kilat_khusus", label: "POS Kilat Khusus" },
];

/** The courier codes for one Rates call (`couriers: "jne,jnt,..."`), in allowlist order,
 * deduplicated. */
export function allowlistCourierCodes(allowlist: readonly AllowlistedService[] = SHIPPING_SERVICE_ALLOWLIST): string[] {
  return [...new Set(allowlist.map((entry) => entry.courierCode))];
}

export interface ShippingCostSplit {
  /** The courier cost as quoted. */
  costAmount: number;
  /** What Ammari covers: `min(cost, SHIPPING_SUBSIDY_MAX_AMOUNT)`. */
  subsidyAmount: number;
  /** The buyer's "Ongkir" (`orders.shipping_amount`): `max(0, cost - SHIPPING_SUBSIDY_MAX_AMOUNT)`. */
  buyerAmount: number;
}

/** Whole rupiah only (CLAUDE.md money rule); anything else is a bug upstream, so it throws. */
export function splitShippingCost(costAmount: number): ShippingCostSplit {
  if (!Number.isSafeInteger(costAmount) || costAmount < 0) {
    throw new RangeError(`shipping cost must be a non-negative whole rupiah amount, got ${costAmount}`);
  }
  const subsidyAmount = Math.min(costAmount, SHIPPING_SUBSIDY_MAX_AMOUNT);
  return { costAmount, subsidyAmount, buyerAmount: costAmount - subsidyAmount };
}

/** The buyer-facing wording of the ongkir rows (owner request after the 2026-10-21 sandbox run: the
 * subsidy must be clearly visible). Shared by checkout, the finish page, the order page and the
 * emails, so every place says the same. */
export const SHIPPING_DISPLAY_LABELS = {
  /** The courier cost as quoted, shown struck through. */
  courierCost: "Ongkir kurir",
  /** Ammari's share, shown highlighted as a negative amount. */
  subsidy: "Subsidi ongkir Ammari",
  /** What the buyer pays for shipping. */
  buyer: "Ongkir",
  /** The buyer's row when the subsidy covers everything. */
  free: "Gratis ongkir",
} as const;

export interface ShippingDisplay {
  /** Set only when a subsidy applied: the courier cost and the subsidy rows are then shown. */
  subsidy: { courierCost: number; amount: number } | null;
  /** "Ongkir", or "Gratis ongkir" when the buyer pays nothing for shipping. */
  buyerLabel: string;
  buyerAmount: number;
}

/** The ongkir rows for an order or a quote: the buyer's share, plus the struck-through courier cost
 * and the subsidy whenever the locked quote has a subsidy above 0. Without a quote (a manual
 * order) only the buyer's row. */
export function shippingDisplay(amounts: { buyerAmount: number; costAmount: number | null; subsidyAmount: number | null }): ShippingDisplay {
  const subsidy =
    amounts.costAmount !== null && amounts.subsidyAmount !== null && amounts.subsidyAmount > 0 ? { courierCost: amounts.costAmount, amount: amounts.subsidyAmount } : null;
  return {
    subsidy,
    buyerLabel: amounts.buyerAmount === 0 && subsidy ? SHIPPING_DISPLAY_LABELS.free : SHIPPING_DISPLAY_LABELS.buyer,
    buyerAmount: amounts.buyerAmount,
  };
}

export interface WeightLine {
  sku: string;
  qty: number;
  /** `products.shipping_weight_grams` of the line's product; null when not filled in yet. */
  weightGrams: number | null;
}

export type ParcelWeightResult =
  | { ok: true; grams: number }
  | { ok: false; reason: "missing_weight" | "empty"; missingSkus: string[] };

/** `sum(qty x shipping_weight_grams) + SHIPPING_PACKAGING_GRAMS` (plan §4.5.3). A product without
 * a weight refuses the whole order (§4.5.5) and names every such SKU for the log. */
export function parcelWeightGrams(lines: readonly WeightLine[]): ParcelWeightResult {
  if (lines.length === 0) return { ok: false, reason: "empty", missingSkus: [] };
  const missing = new Set<string>();
  let grams = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw new RangeError(`line quantity must be a positive integer, got ${line.qty}`);
    if (line.weightGrams === null) missing.add(line.sku);
    else grams += line.qty * line.weightGrams;
  }
  if (missing.size > 0) return { ok: false, reason: "missing_weight", missingSkus: [...missing].sort() };
  return { ok: true, grams: grams + SHIPPING_PACKAGING_GRAMS };
}

/** One service from a Rates response (or a cached copy of one). */
export interface RatedService {
  courierCode: string;
  serviceCode: string;
  cost: number;
}

export interface PickedService extends AllowlistedService {
  cost: number;
}

function serviceKey(courierCode: string, serviceCode: string): string {
  return `${courierCode.trim().toLowerCase()}:${serviceCode.trim().replace(/\s+/g, " ").toUpperCase()}`;
}

/** The services that may be picked, with the allowlist's canonical codes: allowlisted (codes
 * matched ignoring case and extra spaces) and priced as a positive whole rupiah amount. A Rp0 or
 * fractional quote would be a provider error, and Ammari would then pay the real price at
 * booking. This is also what the rate cache stores. Keeps the provider's order. */
export function allowlistedServices(
  services: readonly RatedService[],
  allowlist: readonly AllowlistedService[] = SHIPPING_SERVICE_ALLOWLIST,
): RatedService[] {
  const canonical = new Map(allowlist.map((entry) => [serviceKey(entry.courierCode, entry.serviceCode), entry]));
  const kept: RatedService[] = [];
  for (const service of services) {
    const entry = canonical.get(serviceKey(service.courierCode, service.serviceCode));
    if (!entry || !Number.isSafeInteger(service.cost) || service.cost <= 0) continue;
    kept.push({ courierCode: entry.courierCode, serviceCode: entry.serviceCode, cost: service.cost });
  }
  return kept;
}

/** The lowest-priced allowlisted service, ties broken by allowlist order (decision 18), carrying
 * the allowlist's canonical codes and label. Null when nothing is allowlisted and priced. */
export function pickCheapestService(
  services: readonly RatedService[],
  allowlist: readonly AllowlistedService[] = SHIPPING_SERVICE_ALLOWLIST,
): PickedService | null {
  const rank = new Map(allowlist.map((entry, index) => [serviceKey(entry.courierCode, entry.serviceCode), index]));
  let best: { index: number; cost: number } | null = null;
  for (const service of allowlistedServices(services, allowlist)) {
    const index = rank.get(serviceKey(service.courierCode, service.serviceCode));
    if (index === undefined) continue;
    if (!best || service.cost < best.cost || (service.cost === best.cost && index < best.index)) {
      best = { index, cost: service.cost };
    }
  }
  if (!best) return null;
  const entry = allowlist[best.index];
  if (!entry) return null;
  return { courierCode: entry.courierCode, serviceCode: entry.serviceCode, label: entry.label, cost: best.cost };
}

/** A provider's kode pos (Biteship sends a number) as `shipping_areas.postal_code`: a real kode
 * pos (5 digits, never starting with 0, same rule as `parseShippingAddress`) or NULL. Anything
 * else ("", "0", 4 digits) would fail `shipping_areas_postal_code_format_check` and with it the
 * whole multi-row upsert (session 7 note); the buyer then types the kode pos at checkout (plan
 * §4.5.1). */
export function normalizeProviderPostalCode(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^[1-9][0-9]{4}$/.test(text) ? text : null;
}

export interface ShippingAreaNames {
  province: string;
  city: string;
  district: string;
  subdistrict: string | null;
  postalCode: string | null;
}

/** The read-only area line in checkout section 2 and the area search results (plan §4.3, §4.5.1):
 * "Kecamatan, Kota, Provinsi 12345", with the kelurahan first when an area has one (never with
 * Biteship). Built from the parts, never from the provider's own display name. */
export function formatShippingAreaLabel(area: ShippingAreaNames): string {
  const parts = [area.subdistrict, area.district, area.city, area.province].filter((part): part is string => !!part);
  const line = parts.join(", ");
  return area.postalCode ? `${line} ${area.postalCode}` : line;
}

/** `shipping_areas.search_text`: the label lowercased, without accents or punctuation, single
 * spaced (kept for a later local-first search, plan §4.5.1). */
export function shippingAreaSearchText(area: ShippingAreaNames): string {
  return formatShippingAreaLabel(area)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
