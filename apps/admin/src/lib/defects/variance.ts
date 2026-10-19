import type { DefectDisposalType, DefectMovementType } from "@ammari/db/schema";

// The read-only §4.3 variance figures on purchase documents and production batches
// (docs/plans/suppliers-goods-receipt.md D20/D24/D29, session S6). Pure: the pages pass in rows they
// already read. HPP/pcs is never rewritten; these are reported next to it. Every figure is computed
// from the document's OWN defect rows (exact per row), so a reversal brings each one back exactly.
// Cost data: callers render these only for finance.view_profit.

export interface DefectValueRow {
  type: DefectMovementType;
  /** For a reversal, the type of the row it reverses. */
  reversesType: DefectMovementType | null;
  disposalType: DefectDisposalType | null;
  valueAmount: number | null;
  proceedsAmount: number | null;
}

export type ByDisposalType = Record<DefectDisposalType, number>;

export interface DefectValueSummary {
  /** Defect value still held from this document (Σ value of all its rows). */
  held: number;
  /** "Nilai ditukar": cost that went back to the supplier/tailor, net of reversals. */
  returnedValue: number;
  /** "Nilai cacat dilepas", per type: cost that left the defect pool, net of reversals. Hibah and
   * Dibuang/Dimusnahkan always separate (D29). */
  released: ByDisposalType;
  releasedTotal: number;
  /** "Hasil pelepasan": gross cash received, net of reversals (only Lelang can be non-zero). */
  proceeds: ByDisposalType;
  proceedsTotal: number;
  /** "Kerugian bersih barang cacat" = released − proceeds. Negative is a GAIN (auctioned above its
   * carried cost) and is shown as such, never clamped (§4.3). */
  netLoss: number;
  netLossByType: ByDisposalType;
}

const zero = (): ByDisposalType => ({ auction: 0, donation: 0, discarded: 0 });

/** null when any row's value was stripped (no finance.view_profit). */
export function summarizeDefectValues(rows: readonly DefectValueRow[]): DefectValueSummary | null {
  if (rows.some((row) => row.valueAmount === null)) return null;
  let held = 0;
  let returnedValue = 0;
  const released = zero();
  const proceeds = zero();
  for (const row of rows) {
    const value = row.valueAmount ?? 0;
    held += value;
    const category = row.type === "reversal" ? row.reversesType : row.type;
    if (category === "return_out") returnedValue -= value;
    if (category === "dispose" && row.disposalType) {
      released[row.disposalType] -= value;
      proceeds[row.disposalType] += row.proceedsAmount ?? 0;
    }
  }
  const releasedTotal = released.auction + released.donation + released.discarded;
  const proceedsTotal = proceeds.auction + proceeds.donation + proceeds.discarded;
  return {
    held,
    returnedValue,
    released,
    releasedTotal,
    proceeds,
    proceedsTotal,
    netLoss: releasedTotal - proceedsTotal,
    netLossByType: {
      auction: released.auction - proceeds.auction,
      donation: released.donation - proceeds.donation,
      discarded: released.discarded - proceeds.discarded,
    },
  };
}

/** Integer division rounded half up (away from zero for negatives), no float multiplication. */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0 || !Number.isInteger(denominator)) throw new Error("denominator must be a positive integer");
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  return sign * Math.floor((2 * n + denominator) / (2 * denominator));
}

export interface BatchVarianceLine {
  /** Net pcs accepted into sellable stock. */
  received: number;
  outstanding: number;
  /** The line's frozen HPP/pcs. */
  unitCostAmount: number;
}

export interface BatchVariance {
  /** Pcs accepted into sellable stock. */
  sellablePcs: number;
  /** Their value at the frozen HPP/pcs. */
  sellableValue: number;
  /** "Nilai belum terserap": frozen cost of planned pcs that never arrived — only once the batch is
   * short-closed (while open they are still expected). */
  unabsorbed: number;
  defects: DefectValueSummary;
  /** "HPP riil per pcs" (§4.3) = (sellable value + net defect loss + unabsorbed) / sellable pcs.
   * Once everything is settled (no defect held, nothing still expected) this is exactly the plan's
   * (total batch cost − proceeds) / pcs accepted, because total cost = Σ planned × HPP/pcs. Null
   * when nothing sellable arrived yet. */
  hppRiilPerPcs: number | null;
  /** True while defects are still held or output is still expected: HPP riil may still change. */
  provisional: boolean;
}

export function batchVariance(params: { lines: readonly BatchVarianceLine[]; closed: boolean; defects: DefectValueSummary }): BatchVariance {
  const sellablePcs = params.lines.reduce((sum, line) => sum + line.received, 0);
  const sellableValue = params.lines.reduce((sum, line) => sum + line.received * line.unitCostAmount, 0);
  const missing = params.lines.reduce((sum, line) => sum + Math.max(0, line.outstanding) * line.unitCostAmount, 0);
  const unabsorbed = params.closed ? missing : 0;
  const hppRiilPerPcs = sellablePcs > 0 ? divideRoundHalfUp(sellableValue + params.defects.netLoss + unabsorbed, sellablePcs) : null;
  return {
    sellablePcs,
    sellableValue,
    unabsorbed,
    defects: params.defects,
    hppRiilPerPcs,
    provisional: params.defects.held !== 0 || (!params.closed && missing > 0),
  };
}

export interface PurchaseVariance {
  totalOrdered: number;
  /** "Nilai diterima": value that entered sellable stock (net of reversals). */
  sellableValue: number;
  defects: DefectValueSummary;
  /** "Nilai belum terserap": paid for but never arrived in any form (good, held defective, or
   * released), on a closed/cancelled document; null while the document is open. Returned units
   * whose replacement never came count here. */
  unabsorbed: number | null;
}

export function purchaseVariance(params: { totalOrdered: number; sellableValue: number; closed: boolean; defects: DefectValueSummary }): PurchaseVariance {
  const absorbed = params.sellableValue + params.defects.held + params.defects.releasedTotal;
  return {
    totalOrdered: params.totalOrdered,
    sellableValue: params.sellableValue,
    defects: params.defects,
    unabsorbed: params.closed ? params.totalOrdered - absorbed : null,
  };
}
