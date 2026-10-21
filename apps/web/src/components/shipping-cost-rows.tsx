import { SHIPPING_DISPLAY_LABELS, shippingDisplay } from "@ammari/commerce/shipping-rules";
import { cn } from "@ammari/ui";
import { formatPriceIdr } from "@/lib/format";

// The ongkir rows of a totals <dl> (owner request after the 2026-10-21 sandbox run: the subsidy
// must be clearly visible): the courier cost struck through, the subsidy highlighted, then what the
// buyer pays ("Ongkir Rp15.000", or "Gratis ongkir Rp0"). Used on /checkout (sections 3 and 4), the
// finish page and /orders/<no>; the emails show the same rows (@ammari/commerce/emails). No hooks,
// so it renders in server and client components alike.

export interface ShippingCostRowsProps {
  /** The buyer's share (`orders.shipping_amount`, or the quote's), or null while not quoted yet. */
  buyerAmount: number | null;
  /** The locked quote's courier cost and subsidy; null on an order without a quote. */
  costAmount: number | null;
  subsidyAmount: number | null;
  /** e.g. "JNE Reguler", named on the courier cost row. */
  courierLabel?: string | null;
  /** Prefix for the rows' test ids (`<prefix>-courier-cost`, `-subsidy`, `-shipping`). */
  testIdPrefix: string;
  /** Overrides the buyer row's test id (`<prefix>-shipping`). */
  buyerTestId?: string;
  /** The <dl> sits on `--color-surface` (the summaries): the subsidy row then stands out in white. */
  onSurface?: boolean;
}

export function ShippingCostRows({ buyerAmount, costAmount, subsidyAmount, courierLabel, testIdPrefix, buyerTestId, onSurface = false }: ShippingCostRowsProps) {
  if (buyerAmount === null) {
    return (
      <div className="flex items-center justify-between gap-4">
        <dt>{SHIPPING_DISPLAY_LABELS.buyer}</dt>
        <dd data-testid={`${testIdPrefix}-shipping`}>-</dd>
      </div>
    );
  }
  const display = shippingDisplay({ buyerAmount, costAmount, subsidyAmount });
  return (
    <>
      {display.subsidy && (
        <>
          <div className="flex items-center justify-between gap-4 text-ink-muted">
            <dt>
              {SHIPPING_DISPLAY_LABELS.courierCost}
              {courierLabel ? ` (${courierLabel})` : ""}
              {/* <s> is not announced by most screen readers. */}
              <span className="sr-only"> sebelum subsidi</span>
            </dt>
            <dd data-testid={`${testIdPrefix}-courier-cost`}>
              <s>{formatPriceIdr(display.subsidy.courierCost)}</s>
            </dd>
          </div>
          <div className={cn("-mx-3 flex items-center justify-between gap-4 border-l-2 border-brand px-3 py-2 font-medium text-brand", onSurface ? "bg-bg" : "bg-surface")}>
            <dt>{SHIPPING_DISPLAY_LABELS.subsidy}</dt>
            <dd data-testid={`${testIdPrefix}-subsidy`}>-{formatPriceIdr(display.subsidy.amount)}</dd>
          </div>
        </>
      )}
      <div className="flex items-center justify-between gap-4">
        <dt>
          {display.buyerLabel}
          {!display.subsidy && courierLabel ? ` (${courierLabel})` : ""}
        </dt>
        <dd data-testid={buyerTestId ?? `${testIdPrefix}-shipping`}>{formatPriceIdr(display.buyerAmount)}</dd>
      </div>
    </>
  );
}
