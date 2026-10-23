// The per-product discount ("launching price") rules, docs/plans/product-discount.md §3 and §5.
// Every place that shows or charges a product price resolves it here: storefront pages, the cart,
// placeOrder's order-item snapshot and the admin manual-order picker. Prices are never taken from
// the browser.
//
// Pure and dependency-free on purpose: no schema import, no `server-only`, no clock. `now` is
// always passed in, so a request or an order uses one instant for every line, and the admin's
// linked "Harga setelah diskon" / "Diskon (%)" inputs (a client component) can use the same
// helpers.
//
// All money is whole rupiah in a `number` and all math is integer, matching the bigint
// `mode: "number"` columns. The DB backs the validation up: products_discount_price_amount_check
// (migration 0036) enforces the same three rules as validateDiscountPrice.

/** The rupiah step a percent-derived sale price is rounded DOWN to (owner decision, plan §3.1). */
export const DISCOUNT_PRICE_ROUNDING = 1_000;
/** Smallest discount allowed, in whole percent (owner decision: refuse under 1%). */
export const DISCOUNT_PERCENT_MIN = 1;
/** Largest percent the admin may type. */
export const DISCOUNT_PERCENT_MAX = 99;

/** The product columns the resolver needs, exactly as selected from `products`. */
export interface ProductPricingInput {
  basePrice: number;
  discountPriceAmount: number | null;
  discountEnabled: boolean;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
}

export interface ResolvedUnitPrice {
  /** The undiscounted price: shown struck through when `discounted`, snapshotted as
   * `order_items.list_unit_price`. */
  listPrice: number;
  /** What is charged (`order_items.unit_price`). */
  unitPrice: number;
  discounted: boolean;
  /** The `N% OFF` badge value (floored); null when not discounted. */
  percentOff: number | null;
  /** When the active discount ends (JSON-LD `priceValidUntil`); null when not discounted or
   * open-ended. */
  endsAt: Date | null;
}

export type DiscountPriceIssue = "not_positive" | "not_below_base" | "under_min_percent";

/** Admin status chip: Aktif / Terjadwal / Berakhir / Nonaktif. */
export type DiscountStatus = "active" | "scheduled" | "ended" | "off";

function assertPositiveRupiah(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive whole rupiah amount, got ${value}`);
}

function assertSaleRupiah(listPrice: number, salePrice: number): void {
  assertPositiveRupiah(listPrice, "list price");
  if (!Number.isSafeInteger(salePrice) || salePrice < 0) throw new RangeError(`sale price must be a whole rupiah amount, got ${salePrice}`);
}

/** The badge: the real percentage off, floored. 350.000 -> 279.000 is 20 (20,28%). */
export function discountPercentOff(listPrice: number, salePrice: number): number {
  assertSaleRupiah(listPrice, salePrice);
  return Math.floor(((listPrice - salePrice) * 100) / listPrice);
}

/** The admin's "Diskon (%)" display when the owner typed a Rp price: the real percentage floored
 * to one decimal, returned as tenths (202 = "20,2"). Display only, never stored or submitted. */
export function discountPercentTenths(listPrice: number, salePrice: number): number {
  assertSaleRupiah(listPrice, salePrice);
  return Math.floor(((listPrice - salePrice) * 1_000) / listPrice);
}

/** Why a sale price is not allowed for this base price, or null when it is. Same rules as
 * products_discount_price_amount_check. */
export function validateDiscountPrice(basePrice: number, salePrice: number): DiscountPriceIssue | null {
  if (!Number.isSafeInteger(salePrice) || salePrice < 1) return "not_positive";
  if (salePrice >= basePrice) return "not_below_base";
  if ((basePrice - salePrice) * 100 < basePrice * DISCOUNT_PERCENT_MIN) return "under_min_percent";
  return null;
}

/** The sale price for a percent the owner typed: `floor(base * (100 - p) / 100)`, then rounded
 * DOWN to the nearest Rp1.000. Rounding down raises the real percentage, so the result is
 * accepted only when the badge still reads exactly `percent`; otherwise (only possible below
 * Rp100.000, plan §3.1) it returns null and the admin types the Rp price instead. Also null when
 * the rounded price would be Rp0. Throws RangeError for a percent outside 1..99 or a bad base:
 * the caller validates the typed input first. */
export function salePriceFromPercent(basePrice: number, percent: number): number | null {
  assertPositiveRupiah(basePrice, "base price");
  if (!Number.isInteger(percent) || percent < DISCOUNT_PERCENT_MIN || percent > DISCOUNT_PERCENT_MAX) {
    throw new RangeError(`percent must be a whole number from ${DISCOUNT_PERCENT_MIN} to ${DISCOUNT_PERCENT_MAX}, got ${percent}`);
  }
  const exact = Math.floor((basePrice * (100 - percent)) / 100);
  const rounded = Math.floor(exact / DISCOUNT_PRICE_ROUNDING) * DISCOUNT_PRICE_ROUNDING;
  if (rounded <= 0) return null;
  if (discountPercentOff(basePrice, rounded) !== percent) return null;
  return rounded;
}

/** The stored sale price, when the product's discount is configured with a valid one. */
function validSalePrice(input: ProductPricingInput): number | null {
  if (input.discountPriceAmount === null) return null;
  return validateDiscountPrice(input.basePrice, input.discountPriceAmount) === null ? input.discountPriceAmount : null;
}

/** Toggle on, a valid sale price, and `now` inside the half-open window [start, end). A missing
 * start means "from now", a missing end means "no end". */
export function isDiscountActive(input: ProductPricingInput, now: Date): boolean {
  return discountStatus(input, now) === "active";
}

/** "off" also covers an enabled discount whose stored sale price is invalid, or any invalid Date
 * (`now` or a bound): every comparison with NaN is false, so without the explicit check an Invalid
 * Date would fail OPEN and charge the sale price. */
export function discountStatus(input: ProductPricingInput, now: Date): DiscountStatus {
  if (!input.discountEnabled || validSalePrice(input) === null) return "off";
  const at = now.getTime();
  const start = input.discountStartsAt?.getTime() ?? null;
  const end = input.discountEndsAt?.getTime() ?? null;
  if (!Number.isFinite(at) || (start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) return "off";
  if (start !== null && at < start) return "scheduled";
  if (end !== null && at >= end) return "ended";
  return "active";
}

/** The one place a product's effective unit price is decided.
 *
 * `variantPriceOverride` is for the admin manual-order picker only
 * (`product_variants.price_override_amount`); the storefront, cart and checkout never pass it,
 * since a product has one storefront price (plan §1.1). With an override the list price is the
 * override, and an active discount charges the product's sale price only when it passes
 * validateDiscountPrice against that list price too (lower, and at least 1% off, so the badge never
 * reads 0%): a discount never raises a price. So with an override, `discountStatus` can say
 * "active" while this returns `discounted: false`; that is intended. */
export function resolveUnitPrice(
  input: ProductPricingInput,
  now: Date,
  options: { variantPriceOverride?: number | null } = {},
): ResolvedUnitPrice {
  const listPrice = options.variantPriceOverride ?? input.basePrice;
  const salePrice = isDiscountActive(input, now) ? validSalePrice(input) : null;
  if (salePrice === null || validateDiscountPrice(listPrice, salePrice) !== null) {
    return { listPrice, unitPrice: listPrice, discounted: false, percentOff: null, endsAt: null };
  }
  return {
    listPrice,
    unitPrice: salePrice,
    discounted: true,
    percentOff: discountPercentOff(listPrice, salePrice),
    endsAt: input.discountEndsAt,
  };
}
