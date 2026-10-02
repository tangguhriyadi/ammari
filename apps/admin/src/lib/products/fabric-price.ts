const METERS_PER_YARD = 0.9144;

/** Price per yard = price per meter x 0.9144, rounded to the nearest whole rupiah. `null` in,
 * `null` out — money is never fractional (CLAUDE.md), and a missing price has no conversion. */
export function meterPriceToYardPrice(pricePerMeter: number | null): number | null {
  if (pricePerMeter === null) return null;
  return Math.round(pricePerMeter * METERS_PER_YARD);
}

/** Price per meter = price per yard / 0.9144, rounded to the nearest whole rupiah. */
export function yardPriceToMeterPrice(pricePerYard: number | null): number | null {
  if (pricePerYard === null) return null;
  return Math.round(pricePerYard / METERS_PER_YARD);
}
