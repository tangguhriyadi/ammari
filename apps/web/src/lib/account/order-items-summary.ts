import { sizeLabel } from "@ammari/commerce/size-label";

/** One line for the account page's linked-order list, e.g. "Gamis A (Sage, All Size) x1, ...".
 * The size goes through the shared sizeLabel, so a buyer never sees the stored "ALLSIZE" code. */
export function orderItemsSummary(items: readonly { productName: string; colorName: string; size: string; qty: number }[]): string {
  return items.map((item) => `${item.productName} (${item.colorName}, ${sizeLabel(item.size)}) x${item.qty}`).join(", ");
}
