import { cn } from "@ammari/ui";
import { formatPriceIdr } from "@/lib/format";
import type { StorefrontPrice } from "@/lib/content/storefront-price";

/** A product's price on a tile or the PDP (docs/plans/product-discount.md §9). Discounted: the
 * normal price struck through and muted, then the sale price in the discount red; screen readers
 * get one plain sentence with both instead. No hooks, so both Server and Client Components use it.
 * `className` sets the size/weight. */
export function ProductPrice({ price, className }: { price: StorefrontPrice; className?: string }) {
  if (!price.discounted) {
    return (
      <p className={cn("text-ink", className)} data-testid="product-price">
        {formatPriceIdr(price.unitPrice)}
      </p>
    );
  }

  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-2", className)} data-testid="product-price">
      <span className="sr-only">
        Harga normal {formatPriceIdr(price.listPrice)}, harga diskon {formatPriceIdr(price.unitPrice)}
      </span>
      <s aria-hidden="true" className="font-normal text-ink-muted" data-testid="product-price-list">
        {formatPriceIdr(price.listPrice)}
      </s>
      <span aria-hidden="true" className="text-discount" data-testid="product-price-sale">
        {formatPriceIdr(price.unitPrice)}
      </span>
    </p>
  );
}
