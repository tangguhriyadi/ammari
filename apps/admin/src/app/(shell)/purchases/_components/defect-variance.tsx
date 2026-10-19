import type { ReactNode } from "react";
import { formatRupiah } from "@ammari/ui/lib";
import { DEFECT_DISPOSAL_TYPES } from "@ammari/db/schema";
import { DEFECT_DISPOSAL_TYPE_LABELS } from "@/lib/defects/labels";
import type { DefectValueSummary, PurchaseVariance } from "@/lib/defects/variance";

// The read-only §4.3 value panels (docs/plans/suppliers-goods-receipt.md D20/D24/D29, S6). Cost
// data: only ever rendered for finance.view_profit, by callers that never run the queries
// otherwise. Read-only; proceeds are stored, not booked (no journal entry anywhere).

export function VarianceRow({ label, value, hint, strong = false }: { label: string; value: ReactNode; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-sm text-neutral-600">
        {label}
        {hint && <span className="block text-xs text-neutral-500">{hint}</span>}
      </span>
      <span className={`text-right text-base tabular-nums text-neutral-900${strong ? " font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

/** Net loss shown signed: a negative loss is a gain and says so, never clamped to 0 (§4.3). */
export function formatNetLoss(netLoss: number): string {
  return netLoss < 0 ? `${formatRupiah(-netLoss)} (untung)` : formatRupiah(netLoss);
}

/** The defect part shared by both panels: what was released, per type (Hibah and Dibuang always
 * on their own lines, D29), the proceeds, and the net loss. Types never used are omitted. */
export function DefectReleaseRows({ defects }: { defects: DefectValueSummary }) {
  const used = DEFECT_DISPOSAL_TYPES.filter((type) => defects.released[type] !== 0 || defects.proceeds[type] !== 0);
  return (
    <>
      <VarianceRow label="Nilai cacat masih disimpan" value={formatRupiah(defects.held)} />
      {defects.returnedValue !== 0 && <VarianceRow label="Nilai ditukar" hint="Dikembalikan ke supplier atau penjahit untuk diganti" value={formatRupiah(defects.returnedValue)} />}
      {used.map((type) => (
        <VarianceRow key={type} label={`Nilai cacat dilepas: ${DEFECT_DISPOSAL_TYPE_LABELS[type]}`} value={formatRupiah(defects.released[type])} />
      ))}
      {used.length > 0 && (
        <>
          <VarianceRow label="Hasil pelepasan" hint="Uang yang benar-benar diterima. Dicatat saja, belum masuk pembukuan." value={formatRupiah(defects.proceedsTotal)} />
          <VarianceRow label="Kerugian bersih barang cacat" value={formatNetLoss(defects.netLoss)} strong />
        </>
      )}
    </>
  );
}

export function PurchaseVariancePanel({ variance }: { variance: PurchaseVariance }) {
  return (
    <section aria-labelledby="purchase-variance-heading" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4" data-testid="variance-panel">
      <h2 id="purchase-variance-heading" className="text-base font-semibold text-neutral-900">
        Nilai pesanan
      </h2>
      <VarianceRow label="Total pesanan" value={formatRupiah(variance.totalOrdered)} />
      <VarianceRow label="Nilai diterima" hint="Masuk stok yang bisa dipakai" value={formatRupiah(variance.sellableValue)} />
      <DefectReleaseRows defects={variance.defects} />
      {variance.unabsorbed !== null && (
        <VarianceRow label="Nilai belum terserap" hint="Sudah dibayar tapi tidak pernah datang" value={formatRupiah(variance.unabsorbed)} strong />
      )}
    </section>
  );
}
