import { resolveUnitPrice, type ProductPricingInput, type ResolvedUnitPrice } from "@ammari/db/pricing";
import type { StorefrontProductTile } from "@ammari/db/storefront";

// The storefront's side of docs/plans/product-discount.md §7: the product data is cached with the
// RAW discount fields, and the effective price is decided here, per request, with that request's
// own `now`. A discount therefore shows from the first request at or after `starts_at` and is gone
// from the first request at `ends_at`, with no cron and no revalidation involved.

/** `ProductPricingInput` as it reaches a page: straight from @ammari/db/storefront (Dates), or out
 * of `unstable_cache`, which stores results as JSON, so a cache hit returns the window bounds as
 * ISO strings. */
export type StorefrontPricingInput = Omit<ProductPricingInput, "discountStartsAt" | "discountEndsAt"> & {
  discountStartsAt: Date | string | null;
  discountEndsAt: Date | string | null;
};

/** What a tile or the PDP panel renders. `percentOff` is the floored `N% OFF` badge value, null
 * when not discounted. */
export type StorefrontPrice = Pick<ResolvedUnitPrice, "listPrice" | "unitPrice" | "discounted" | "percentOff">;

/** A tile as it comes out of the cache. */
export type CachedProductTile = Omit<StorefrontProductTile, "pricing"> & { pricing: StorefrontPricingInput };

/** A tile ready to render: the raw pricing replaced by the price for this request. */
export type PricedProductTile = Omit<StorefrontProductTile, "pricing"> & { price: StorefrontPrice };

// An unparseable string becomes an Invalid Date, which resolveUnitPrice treats as "no discount"
// (fails closed: the normal price shows).
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export function resolveStorefrontPrice(pricing: StorefrontPricingInput, now: Date): ResolvedUnitPrice {
  return resolveUnitPrice(
    { ...pricing, discountStartsAt: toDate(pricing.discountStartsAt), discountEndsAt: toDate(pricing.discountEndsAt) },
    now,
  );
}

export function toStorefrontPrice(resolved: ResolvedUnitPrice): StorefrontPrice {
  return { listPrice: resolved.listPrice, unitPrice: resolved.unitPrice, discounted: resolved.discounted, percentOff: resolved.percentOff };
}

/** Every tile priced at one `now`, so one page never mixes two instants. */
export function priceTiles(tiles: readonly CachedProductTile[], now: Date): PricedProductTile[] {
  return tiles.map(({ pricing, ...tile }) => ({ ...tile, price: toStorefrontPrice(resolveStorefrontPrice(pricing, now)) }));
}

const JAKARTA_ISO_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });

/** JSON-LD `offers.priceValidUntil`: the last Asia/Jakarta calendar date (YYYY-MM-DD) the sale
 * price applies on, or undefined when nothing is discounted or the discount has no end. The end is
 * exclusive, so one ending at 00:00 WIB is last valid the day before. */
export function priceValidUntil(resolved: ResolvedUnitPrice): string | undefined {
  if (!resolved.discounted || resolved.endsAt === null) return undefined;
  return JAKARTA_ISO_DATE.format(new Date(resolved.endsAt.getTime() - 1));
}
