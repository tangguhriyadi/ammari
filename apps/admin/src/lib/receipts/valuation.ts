// Receipt valuation (docs/plans/suppliers-goods-receipt.md §4.2) — pure, integer-only, no floats
// anywhere in the money path. A purchase line knows only `qty_ordered` and `total_amount` (what
// the owner typed, ongkir included — D6); each arrival is valued as a cumulative-rounding slice of
// that total, so partial receipts sum to EXACTLY the amount paid, with no stranded rupiah and
// without anything needing to know which receipt is the last one.

/** Quantities are numeric(10,2): convert to integer hundredths ("centi-units") before any
 * arithmetic. `Math.round(q * 100)` is exact for every value the column can hold (at most two
 * decimals, well inside float precision), unlike multiplying money by a fractional quantity. */
export function toCentiQty(qty: number): bigint {
  if (!Number.isFinite(qty)) throw new Error(`invalid quantity: ${qty}`);
  return BigInt(Math.round(qty * 100));
}

/** round(numerator / denominator), half up, for numerator >= 0 and denominator > 0. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/** The cumulative value owed for `settledCenti` of `qtyOrderedCenti` units of a line that cost
 * `totalAmount`: roundHalfUp(total × settled / ordered). At settled = ordered it is exactly
 * `totalAmount`. */
export function cumulativeValue(totalAmount: number, qtyOrderedCenti: bigint, settledCenti: bigint): number {
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) throw new Error(`invalid total amount: ${totalAmount}`);
  if (qtyOrderedCenti <= 0n) throw new Error("qty ordered must be positive");
  if (settledCenti < 0n || settledCenti > qtyOrderedCenti) throw new Error("settled quantity out of range");
  return Number(divideRoundHalfUp(BigInt(totalAmount) * settledCenti, qtyOrderedCenti));
}

export interface SliceInput {
  totalAmount: number;
  qtyOrdered: number;
  /** Net quantity already settled on this line before this arrival (net of reversals). */
  settledBefore: number;
  /** Net value already booked for this line before this arrival (net of reversals) — the SUM of
   * this line's own ledger rows. */
  valueBefore: number;
  /** Quantity arriving now; > 0. */
  qtyNow: number;
}

/** The value of one arrival: `cumulativeValue(settledBefore + qtyNow) − valueBefore`.
 *
 * With no reversals in between, `valueBefore` is exactly `cumulativeValue(settledBefore)`, so this
 * is precisely §4.2's `roundHalfUp(T·(s+n)/Q) − roundHalfUp(T·s/Q)`. Subtracting the value
 * ACTUALLY booked rather than recomputing `cumulativeValue(settledBefore)` is what keeps the
 * total exact when a receipt that is not the latest one has been reversed (its exact negation
 * can leave the booked value a rupiah away from the formula at the new settled quantity); the
 * next arrival absorbs that difference instead of stranding it. Clamped at 0 so no slice is ever
 * negative; whatever a clamp leaves over is absorbed by a later slice, and the slice that
 * completes the line is always exactly `totalAmount − valueBefore` (never negative, since the
 * booked value can never exceed the total), so a fully settled line sums to exactly
 * `totalAmount` in every order of receipts and reversals. */
export function sliceValue(input: SliceInput): number {
  const ordered = toCentiQty(input.qtyOrdered);
  const before = toCentiQty(input.settledBefore);
  const now = toCentiQty(input.qtyNow);
  if (now <= 0n) throw new Error("arriving quantity must be positive");
  if (before + now > ordered) throw new Error("arrival exceeds the ordered quantity");
  const target = cumulativeValue(input.totalAmount, ordered, before + now);
  return Math.max(0, target - input.valueBefore);
}
