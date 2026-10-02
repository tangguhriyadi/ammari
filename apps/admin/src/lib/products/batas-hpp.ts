/** The subset of a `cost_assumptions` row this calculation needs — pure, so tests don't need a
 * full Drizzle row shape. */
export interface CostAssumptionRates {
  marketplaceFeeBps: number;
  adsBps: number;
  returnsReserveBps: number;
  targetProfitBps: number;
  packagingCostAmount: number;
}

/** "Batas HPP" (docs/SPEC.md §7): basePrice x (100% - marketplaceFee - ads - returnsReserve -
 * targetProfit) - packagingCost. NOT hardcoded as "x 47% - Rp4.000" — derived from whichever
 * cost_assumptions row is in effect, so it stays correct if assumptions ever change (today's
 * seeded row happens to sum to exactly 47%: 18+12+3+20 = 53, 100-53 = 47). Rounded to the
 * nearest whole rupiah, matching the order_items weighted-average rounding convention. */
export function calculateBatasHpp(basePrice: number, rates: CostAssumptionRates): number {
  const marginBps = 10_000 - rates.marketplaceFeeBps - rates.adsBps - rates.returnsReserveBps - rates.targetProfitBps;
  return Math.round((basePrice * marginBps) / 10_000) - rates.packagingCostAmount;
}
