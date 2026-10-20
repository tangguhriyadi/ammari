import { cumulativeValue, toCentiQty } from "@/lib/receipts/valuation";

// Defect outflow valuation (docs/plans/suppliers-goods-receipt.md §4.2, §10 R1) — pure,
// integer-only. A return ('return_out') or a release ('dispose') is valued at its SOURCE LINE's own
// defect value, never at the item's pooled defect average: two purchases (or batches) of the same
// item at different prices keep their own values, so a replacement after a return enters sellable
// stock at the returning line's price and nothing moves between documents.
//
// Same cumulative-rounding shape as a receipt slice (sliceValue): the line's net rejects are the
// "total", the line's net outflows are what is already "settled", and each outflow is the cumulative
// target minus the value actually booked. So partial outflows over any number of steps sum to
// EXACTLY the line's reject value when its defects are fully disposed, reversals (exact negations)
// are absorbed by the next outflow, and the cumulative value after k units does not depend on the
// step sizes.

export interface LineDefectTotals {
  /** Net qty rejected on the line: 'reject' rows plus their reversals. */
  rejectedQty: number;
  /** Net value of those rows (>= 0: reversals negate exactly). */
  rejectedValue: number;
  /** Net qty that left the line: 'return_out'/'dispose' rows plus their reversals, as a positive
   * number. */
  outQty: number;
  /** Net value of those rows, as a positive number. */
  outValue: number;
}

/** The value (positive: what leaves the defect ledger; the row stores its negation) of an outflow
 * of `qty` from a line.
 *
 * - The outflow that empties the line takes exactly the held value (rejectedValue − outValue), so
 *   a line at 0 held is at Rp 0, whatever happened before.
 * - Otherwise: cumulativeValue(rejectedValue, rejectedQty, outQty + qty) − outValue, clamped to
 *   [0, held value]. The clamp never binds for rows written by this rule; it exists for rows
 *   written before R1 at the pooled average (dev data only), whose line value can sit off the
 *   cumulative target, or even below 0 — the final outflow then heals the line exactly. */
export function lineOutflowValue(totals: LineDefectTotals, qty: number): number {
  const now = toCentiQty(qty);
  const rejected = toCentiQty(totals.rejectedQty);
  const out = toCentiQty(totals.outQty);
  const held = rejected - out;
  if (now <= 0n) throw new Error("outflow quantity must be positive");
  if (now > held) throw new Error("outflow exceeds the line's held defect quantity");
  const heldValue = totals.rejectedValue - totals.outValue;
  if (now === held) return heldValue;
  const target = cumulativeValue(totals.rejectedValue, rejected, out + now) - totals.outValue;
  return Math.min(Math.max(target, 0), Math.max(heldValue, 0));
}
