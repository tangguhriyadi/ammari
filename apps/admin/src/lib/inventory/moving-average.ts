/** A raw-material item's running totals, as derived from `SUM(qty)`/`SUM(value_amount)` over its
 * movement ledger (accessory_movements or fabric_stock_movements) — never a stored/cached
 * counter, per the product spec's explicit requirement. See those tables' own doc comments in
 * packages/db/src/schema/catalog.ts for why a plain SUM is enough to also yield a correct
 * moving-average cost, not just a stock count. */
export interface RawMaterialBalance {
  qty: number;
  valueAmount: number;
}

/** The current average cost per unit, or `null` when there's no stock to average over (qty <=
 * 0) — this is the ONLY place "average cost" is ever computed; it is never itself stored. */
export function averageCostPerUnit(balance: RawMaterialBalance): number | null {
  if (balance.qty <= 0) return null;
  return balance.valueAmount / balance.qty;
}

/** The `value_amount` a 'production' or 'adjustment' movement should carry, given the item's
 * balance BEFORE this movement (read under the item's row lock — see lib/inventory/db.ts) and
 * the signed qty delta being applied. The caller must have already verified
 * `balance.qty + qtyDelta >= 0` (same "lock, check negative, write" discipline adjustStock uses)
 * — this function has no way to reject a would-be-negative result itself.
 *
 * Correction #1 (approved plan, binding): if this movement brings qty to EXACTLY zero, the value
 * delta is forced to exactly `-balance.valueAmount` — clearing any rounding residue — rather than
 * a separately-rounded `qtyDelta * average`. This is what keeps the invariant `qty = 0 => value =
 * 0` and `qty > 0 => value >= 0` EXACT: a plain `round(qty * avg)` can in principle leave a few
 * rupiah of value stranded at zero stock (or, worse, computed from a since-rounded average
 * elsewhere), which would corrupt the NEXT purchase's average or divide-by-zero against a
 * leftover value with no quantity behind it.
 *
 * NEVER used for a 'purchase' (its value_amount is simply the exact amount paid, no rounding at
 * all) or a 'purchase_void' (an exact negation of the original purchase row's own qty/value) —
 * both bypass this function entirely; only a consumption or a stock-level adjustment goes
 * through the average at all, because only those movement types have no amount of their own to
 * record and must be valued AT the item's current cost basis instead. */
export function valueDeltaForConsumption(balance: RawMaterialBalance, qtyDelta: number): number {
  const qtyAfter = balance.qty + qtyDelta;
  if (qtyAfter === 0) return -balance.valueAmount;
  const average = averageCostPerUnit(balance);
  // `average` is only null when balance.qty <= 0 — the one reachable case is a POSITIVE
  // adjustment (qtyDelta > 0) applied to zero existing stock (qtyAfter > 0, found "free"
  // quantity with no cost basis yet); valuing it at 0 is the correct, unambiguous fallback. A
  // NEGATIVE qtyDelta from qty <= 0 is a precondition violation the caller must have already
  // rejected (there is nothing to consume).
  return Math.round(qtyDelta * (average ?? 0));
}
