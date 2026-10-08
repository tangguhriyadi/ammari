/** `ceil(total batch cost / total pcs)` — the same unit cost applies to every line of a batch
 * regardless of SKU, rounded UP so the batch's recorded cost never understates actual spend
 * (unlike order_items' weighted-average rounding, which rounds to nearest). `totalPcs` is
 * guaranteed > 0 by the caller (postBatch refuses to post a batch with no lines). */
export function calculateUnitCost(totalCost: number, totalPcs: number): number {
  return Math.ceil(totalCost / totalPcs);
}
