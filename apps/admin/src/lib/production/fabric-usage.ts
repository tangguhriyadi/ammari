import { averageCostPerUnit, type RawMaterialBalance } from "@ammari/commerce/moving-average";

// Client-safe helpers for a batch's fabric usage per colour bucket
// (docs/plans/fabric-colour-stock.md D6, owner decision A4). No server-only imports: the draft
// form and the server share them.

/** `null` = the "Tanpa warna" bucket. */
export type FabricUsageSource = string | null;

export interface FabricUsageRow {
  fabricColorId: FabricUsageSource;
  yards: number;
}

/** Yards as whole hundredths (numeric(10,2)), so sums and comparisons never go through float
 * rounding (0.1 + 0.2 style). */
export function toCentiYards(yards: number): number {
  return Math.round(yards * 100);
}

export function fromCentiYards(centi: number): number {
  return centi / 100;
}

/** The default usage split (A4): the batch's total yards divided over the colours of its lines
 * in proportion to their pcs. Every SKU maps to exactly one fabric colour, so `pcsByColor` is
 * always complete. Rounded down to 0.01 yard per colour; the remainder goes to the colour with the
 * most pcs (the first one on a tie), so the rows always add up to `totalYards` exactly. A colour
 * whose share rounds to 0.00 is left out (a usage row must be > 0). Colours keep the given order. */
export function splitYardsByPcs(totalYards: number | null, pcsByColor: readonly { fabricColorId: string; pcs: number }[]): FabricUsageRow[] {
  const colors = pcsByColor.filter((row) => row.pcs > 0);
  if (totalYards === null || totalYards <= 0 || colors.length === 0) return [];
  const totalCenti = toCentiYards(totalYards);
  const totalPcs = colors.reduce((sum, row) => sum + row.pcs, 0);
  const shares = colors.map((row) => Math.floor((totalCenti * row.pcs) / totalPcs));
  const remainder = totalCenti - shares.reduce((sum, share) => sum + share, 0);
  let largest = 0;
  colors.forEach((row, index) => {
    if (row.pcs > colors[largest]!.pcs) largest = index;
  });
  shares[largest]! += remainder;
  return colors
    .map((row, index) => ({ fabricColorId: row.fabricColorId, yards: fromCentiYards(shares[index]!) }))
    .filter((row) => row.yards > 0);
}

/** Pcs per fabric colour, in order of first appearance. */
export function pcsByFabricColor(lines: readonly { colorId: string; qty: number }[]): { fabricColorId: string; pcs: number }[] {
  const byColor = new Map<string, number>();
  for (const line of lines) {
    if (line.qty <= 0) continue;
    byColor.set(line.colorId, (byColor.get(line.colorId) ?? 0) + line.qty);
  }
  return [...byColor].map(([fabricColorId, pcs]) => ({ fabricColorId, pcs }));
}

export function sumUsageYards(rows: readonly { yards: number }[]): number {
  return fromCentiYards(rows.reduce((sum, row) => sum + toCentiYards(row.yards), 0));
}

/** How many yards a usage row is short of its bucket (0 when the bucket covers it). */
export function usageShortfall(yards: number, bucketQty: number): number {
  return fromCentiYards(Math.max(0, toCentiYards(yards) - toCentiYards(bucketQty)));
}

/** "12.5" for 12.50, "10" for 10.00: the text an input shows for a yard amount. */
export function formatYardsInput(yards: number): string {
  return String(fromCentiYards(toCentiYards(yards)));
}

/** A non-binding draft estimate: Σ each row's yards × its OWN bucket's current moving average
 * (A1). `null` when there is nothing to estimate or any row's bucket has no average yet (no stock),
 * so the UI shows "-" instead of a partial figure. Posting values the real consumption. */
export function estimateFabricUsageCost(
  rows: readonly FabricUsageRow[],
  balanceOf: (source: FabricUsageSource) => RawMaterialBalance | undefined,
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const balance = balanceOf(row.fabricColorId);
    const average = balance ? averageCostPerUnit(balance) : null;
    if (average === null) return null;
    total += row.yards * average;
  }
  return Math.round(total);
}
