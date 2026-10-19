import { Badge, Card } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { DefectItemKind } from "@ammari/db/schema";
import type { DocumentDefectMovementRow } from "@/lib/defects/queries";
import { DEFECT_DISPOSAL_TYPE_LABELS, DEFECT_MOVEMENT_TYPE_LABELS } from "@/lib/defects/labels";
import { ReverseDefectButton } from "./defect-actions";

export function formatDefectQty(itemKind: DefectItemKind, qty: number): string {
  return itemKind === "fabric" ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

const REVERSE_DESCRIPTIONS = {
  return_out:
    "Barang kembali ke stok cacat dan sisa pesanan berkurang lagi. Tidak bisa jika barang penggantinya sudah diterima: batalkan penerimaan pengganti dulu.",
  dispose: "Barang kembali ke stok cacat. Nilai dan hasil pelepasan ini dibalik.",
} as const;

/** One document's defect history (docs/plans/suppliers-goods-receipt.md §7, S5 + S6), newest
 * first, shared by purchase documents and production batches: each row's type, quantity, value,
 * proceeds and notes. Quantities always; value and proceeds only when the caller passed rows with
 * them (finance.view_profit, stripped otherwise). `canReverse` (inventory.manage) adds "Batalkan"
 * to a live return or release; a reject is reversed with its receipt instead. */
export function DefectHistory({ rows, emptyText, canReverse = false }: { rows: DocumentDefectMovementRow[]; emptyText: string; canReverse?: boolean }) {
  if (rows.length === 0) return <p className="text-base text-neutral-600">{emptyText}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} data-testid="defect-row">
          <Card className={`flex flex-col gap-2${row.reversedAt !== null ? " opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-medium text-neutral-900">{row.itemName}</p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="neutral">
                  {DEFECT_MOVEMENT_TYPE_LABELS[row.type]}
                  {row.disposalType ? ` · ${DEFECT_DISPOSAL_TYPE_LABELS[row.disposalType]}` : ""}
                </Badge>
                {row.reversedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
              </div>
            </div>
            <p className="text-base tabular-nums text-neutral-900">
              {formatDefectQty(row.itemKind, row.qty)}
              {row.valueAmount !== null && <span className="text-sm text-neutral-600"> · Nilai {formatRupiah(row.valueAmount)}</span>}
              {row.proceedsAmount !== null && row.disposalType !== null && (
                <span className="text-sm text-neutral-600"> · Hasil {formatRupiah(row.proceedsAmount)}</span>
              )}
            </p>
            {row.note && row.type !== "reject" && <p className="text-sm text-neutral-800">{row.note}</p>}
            <p className="text-sm text-neutral-600">
              {formatDate(new Date(row.occurredAt))}
              {row.receiptNo ? ` · ${row.receiptNo}` : ""}
              {" · "}dicatat {formatDateTime(row.createdAt)}
              {row.createdByName ? ` oleh ${row.createdByName}` : ""}
            </p>
            {canReverse && row.reversedAt === null && (row.type === "return_out" || row.type === "dispose") && (
              <div>
                <ReverseDefectButton
                  movementId={row.id}
                  description={REVERSE_DESCRIPTIONS[row.type]}
                  label={`Batalkan ${row.type === "dispose" ? "pelepasan" : "pengembalian"} ${row.itemName} ${formatDefectQty(row.itemKind, -row.qty)}, ${formatDate(new Date(row.occurredAt))}`}
                />
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
