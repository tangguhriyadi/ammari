import Link from "next/link";
import { formatPriceIdr } from "@/lib/format";
import type { CustomerOrderRow } from "@/lib/orders/queries";

// "Pesanan saya" rows (docs/plans/cart-checkout.md §9.1): number, date, status, items and, for
// storefront orders, the total paid; the whole row links to the order page. One layout from phone to
// desktop (a short list of cards, not a table), checked at 390 px and 1280 px.

/** `compact`: always stacked (the narrow /account column), whatever the viewport. */
export function OrderList({ rows, compact = false }: { rows: CustomerOrderRow[]; compact?: boolean }) {
  const wide = compact ? "" : " md:flex-row md:items-start md:justify-between md:gap-6";
  const side = compact ? "" : " md:flex-col md:items-end md:gap-1";
  return (
    <ul className="flex flex-col gap-3" data-testid="order-list">
      {rows.map((order) => (
        <li key={order.orderNo}>
          <Link
            href={`/orders/${order.orderNo}`}
            className={`flex flex-col gap-2 border border-line p-4 transition-colors duration-150 hover:bg-surface${wide}`}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-medium text-ink">{order.orderNo}</p>
              <p className="text-xs text-ink-muted">
                {order.orderedOn}
                {order.isCheckout ? "" : ` · ${order.channelName}`}
              </p>
              <p className="text-sm text-ink-soft">
                {order.items.map((item) => `${item.name} (${item.variant}) ×${item.qty}`).join(", ")}
              </p>
            </div>
            <div className={`flex shrink-0 items-center justify-between gap-4${side}`}>
              <p className="text-sm text-ink" data-testid="order-row-status">
                {order.status.label}
              </p>
              {order.total !== null && <p className="text-sm font-medium text-ink">{formatPriceIdr(order.total)}</p>}
              <span aria-hidden="true" className="text-xs tracking-[0.16em] text-ink uppercase underline underline-offset-4">
                Lihat
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
