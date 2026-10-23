// The struck "normal price" of an order line, from its snapshot only (docs/plans/product-discount.md
// §5.2): `order_items.list_unit_price` is set when a product discount (or, for a manual order, a
// lower price) charged less than the normal price, and NULL otherwise (older orders, marketplace
// orders, undiscounted lines). The current product price is never consulted.

/** The line at its normal price when that is above what was charged, else null. */
export function snapshotListLineTotal(line: { qty: number; unitPrice: number; listUnitPrice: number | null }): number | null {
  return line.listUnitPrice !== null && line.listUnitPrice > line.unitPrice ? line.qty * line.listUnitPrice : null;
}

/** "Hemat": what the lines' discounts took off their normal prices (0 when none). */
export function snapshotSavings(lines: readonly { qty: number; unitPrice: number; listUnitPrice: number | null }[]): number {
  return lines.reduce((sum, line) => {
    const list = snapshotListLineTotal(line);
    return list === null ? sum : sum + list - line.qty * line.unitPrice;
  }, 0);
}
