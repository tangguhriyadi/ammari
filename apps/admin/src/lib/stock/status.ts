export type StockStatus = "habis" | "menipis" | "ok";

/** "Habis" (out) always wins at exactly zero, regardless of `minStockQty` — a SKU with no
 * minimum set (0, the column default) is never flagged "menipis" just for being low, per
 * docs/SPEC.md's "Menipis" rule (`stock <= min_stock && min_stock > 0`). */
export function stockStatus(currentStock: number, minStockQty: number): StockStatus {
  if (currentStock <= 0) return "habis";
  if (minStockQty > 0 && currentStock <= minStockQty) return "menipis";
  return "ok";
}
