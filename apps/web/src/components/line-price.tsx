import { cn } from "@ammari/ui";
import { formatPriceIdr } from "@/lib/format";

/** A line total in the cart, checkout summary and order pages (docs/plans/product-discount.md §9).
 * When a product discount made the line cheaper (`listTotal` above `total`): the normal total struck
 * through and muted, then the paid total in the discount red; screen readers get one plain sentence
 * with both instead. Otherwise just the total. No hooks, so Server and Client Components both use
 * it. `className` sets the size/weight. */
export function LinePrice({ total, listTotal, className }: { total: number; listTotal: number | null; className?: string }) {
  if (listTotal === null || listTotal <= total) {
    return (
      <p className={cn("text-ink", className)} data-testid="line-price">
        {formatPriceIdr(total)}
      </p>
    );
  }
  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-2", className)} data-testid="line-price">
      <span className="sr-only">
        Harga normal {formatPriceIdr(listTotal)}, harga diskon {formatPriceIdr(total)}
      </span>
      <s aria-hidden="true" className="font-normal text-ink-muted" data-testid="line-price-list">
        {formatPriceIdr(listTotal)}
      </s>
      <span aria-hidden="true" className="text-discount" data-testid="line-price-sale">
        {formatPriceIdr(total)}
      </span>
    </p>
  );
}

/** The "Hemat RpX" row of a summary `<dl>` (owner answer 8): what the product discounts took off
 * the normal prices. Nothing when there is no saving. */
export function SavingsRow({ amount, testId }: { amount: number; testId: string }) {
  if (amount <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-discount">
      <dt>Hemat</dt>
      <dd data-testid={testId}>{formatPriceIdr(amount)}</dd>
    </div>
  );
}
