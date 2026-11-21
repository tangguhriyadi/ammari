import type { FabricColorBalanceRow } from "@/lib/inventory/fabric-stock";

/** One colour bucket of a fabric as the draft form shows it next to a "Pemakaian kain" row
 * (docs/plans/fabric-colour-stock.md S5). */
export interface FabricUsageStock {
  /** `null` = "Tanpa warna". */
  fabricColorId: string | null;
  name: string | null;
  hex: string | null;
  isActive: boolean;
  qty: number;
  /** Cost data: `null` for a session without finance.view_profit, stripped server-side. */
  valueAmount: number | null;
}

export function toFabricUsageStock(rows: readonly FabricColorBalanceRow[], canViewProfit: boolean): FabricUsageStock[] {
  return rows.map((row) => ({
    fabricColorId: row.fabricColorId,
    name: row.name,
    hex: row.hex,
    isActive: row.isActive,
    qty: row.qty,
    valueAmount: canViewProfit ? row.valueAmount : null,
  }));
}
