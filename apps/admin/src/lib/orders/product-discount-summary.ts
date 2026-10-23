type DiscountableLine = { qty: number; unitPrice: number; listUnitPrice: number | null };

/** Display-only totals for the order summary. Null when no line was sold below its normal price,
 * so the summary stays exactly as it was for orders without a product discount. */
export function productDiscountSummary(
  items: readonly DiscountableLine[],
  subtotalAmount: number,
): { listTotal: number; discount: number } | null {
  if (!items.some((item) => item.listUnitPrice !== null && item.listUnitPrice > item.unitPrice)) return null;
  const listTotal = items.reduce((sum, item) => sum + (item.listUnitPrice ?? item.unitPrice) * item.qty, 0);
  return { listTotal, discount: listTotal - subtotalAmount };
}
