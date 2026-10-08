/** A live, display-only preview of what `production_batch_costs.total` (a Postgres GENERATED
 * column, `round(quantity * unit_price)`) will compute once saved — never the authoritative
 * value itself, just shown in the UI before the row round-trips to the server.
 *
 * Deliberately NOT `Math.round(quantity * unitPrice)` — IEEE 754 float multiplication can land
 * on the wrong side of a .5 boundary from what Postgres's exact `numeric` arithmetic computes
 * (0.35 * 10 is 3.4999999999999996 in JS but exactly 3.5 in Postgres, which rounds the OPPOSITE
 * way: 3 vs 4). Converting the quantity to an exact integer number of hundredths first (safe,
 * since every quantity here has at most 2 decimal places by construction — see
 * decimal-quantity.ts) keeps the multiplication in integer arithmetic until the final division,
 * matching Postgres's result exactly instead of merely approximating it. */
export function previewLineTotal(quantity: number, unitPrice: number): number {
  const hundredths = Math.round(quantity * 100);
  return Math.round((hundredths * unitPrice) / 100);
}
