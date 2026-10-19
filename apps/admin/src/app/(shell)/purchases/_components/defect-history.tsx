import { Badge, Card } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { DefectItemKind } from "@ammari/db/schema";
import type { DocumentDefectMovementRow } from "@/lib/defects/queries";
import { DEFECT_DISPOSAL_TYPE_LABELS, DEFECT_MOVEMENT_TYPE_LABELS } from "@/lib/defects/labels";

export function formatDefectQty(itemKind: DefectItemKind, qty: number): string {
  return itemKind === "fabric" ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

/** One document's defect history (docs/plans/suppliers-goods-receipt.md §7, S5), newest first —
 * shared by purchase documents and production batches. Quantities always; value only when the
 * caller passed rows with it (finance.view_profit, stripped otherwise). Read-only: returning and
 * releasing defects arrive in S6. */
export function DefectHistory({ rows, emptyText }: { rows: DocumentDefectMovementRow[]; emptyText: string }) {
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
            <p className="text-sm text-neutral-600">
              {formatDate(new Date(row.occurredAt))}
              {row.receiptNo ? ` · ${row.receiptNo}` : ""}
              {" · "}dicatat {formatDateTime(row.createdAt)}
              {row.createdByName ? ` oleh ${row.createdByName}` : ""}
            </p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
