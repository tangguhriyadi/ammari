import type { FabricPriceUnit } from "@ammari/db/schema";
import { meterPriceToYardPrice } from "@/lib/products/fabric-price";

export interface FabricPriceInfo {
  priceAmount: number | null;
  priceUnit: FabricPriceUnit | null;
}

/** A non-binding prefill, never a hard requirement — `null` whenever either input is missing
 * (no yards entered yet, or the fabric has no price on file), in which case the form simply
 * leaves the fabric cost field for the operator to fill in by hand, same as today.
 *
 * Converts via the existing meterPriceToYardPrice (0.9144 m/yard) when the fabric's own price is
 * stored per meter — never assumes the unit, since Pasar Baru suppliers quote both ways. */
export function suggestFabricCost(fabricYards: number | null, fabric: FabricPriceInfo): number | null {
  if (fabricYards === null || fabric.priceAmount === null || fabric.priceUnit === null) return null;
  const pricePerYard = fabric.priceUnit === "yard" ? fabric.priceAmount : meterPriceToYardPrice(fabric.priceAmount);
  if (pricePerYard === null) return null;
  return Math.round(fabricYards * pricePerYard);
}
