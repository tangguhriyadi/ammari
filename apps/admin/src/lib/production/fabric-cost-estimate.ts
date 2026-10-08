import { averageCostPerUnit, type RawMaterialBalance } from "@/lib/inventory/moving-average";

/** A non-binding, display-only estimate of what this draft's fabric consumption will cost once
 * posted — `fabricYards × the fabric's CURRENT moving-average cost per yard` (see
 * lib/inventory/moving-average.ts). Replaces the old manual "Biaya bahan" input: the fabric cost
 * is no longer hand-typed at draft time at all, only computed, and only becomes authoritative at
 * posting (postBatch values the actual consumption at whatever the average is AT THAT MOMENT,
 * which can differ from this estimate if a purchase lands in between).
 *
 * `null` whenever there's nothing to estimate from: no yards entered yet, or the fabric has no
 * purchase history (zero stock, so no average cost exists yet) — the UI then shows "—" rather
 * than a misleading 0. */
export function estimateFabricCost(fabricYards: number | null, fabricBalance: RawMaterialBalance): number | null {
  if (fabricYards === null) return null;
  const average = averageCostPerUnit(fabricBalance);
  if (average === null) return null;
  return Math.round(fabricYards * average);
}
