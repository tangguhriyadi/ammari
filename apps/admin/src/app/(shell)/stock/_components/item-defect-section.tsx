import Link from "next/link";
import { Badge, Card } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { DefectItemKind } from "@ammari/db/schema";
import { ITEM_DEFECT_LEDGER_LIMIT, type ItemDefectMovementRow } from "@/lib/defects/queries";
import { DEFECT_DISPOSAL_TYPE_LABELS, DEFECT_MOVEMENT_TYPE_LABELS } from "@/lib/defects/labels";

function formatQty(kind: DefectItemKind, qty: number): string {
  return kind === "fabric" ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

/** "Stok cacat" on an item detail page (docs/plans/suppliers-goods-receipt.md §7, S5b): the pooled
 * defect balance and the item's defect ledger, each row linking back to its source document and
 * showing proceeds on a release. Quantity always; value and proceeds only when the page passed
 * them (finance.view_profit, stripped server-side). Read-only: dispositions happen on the source
 * document. A link is rendered only when the session can open its target (purchases need
 * inventory.view, batches production.manage). */
export function ItemDefectSection({
  kind,
  balance,
  rows,
  canOpenPurchase,
  canOpenBatch,
}: {
  kind: DefectItemKind;
  balance: { qty: number; valueAmount: number | null };
  rows: ItemDefectMovementRow[];
  canOpenPurchase: boolean;
  canOpenBatch: boolean;
}) {
  return (
    <section aria-labelledby="item-defect-heading" className="mt-8 flex flex-col gap-3" data-testid="item-defect-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="item-defect-heading" className="text-lg font-semibold text-neutral-900">
          Barang cacat
        </h2>
        <p className="text-base text-neutral-900">
          Stok cacat <span className="font-semibold tabular-nums" data-testid="item-defect-qty">{formatQty(kind, balance.qty)}</span>
          {balance.valueAmount !== null && <span className="text-sm text-neutral-600"> · {formatRupiah(balance.valueAmount)}</span>}
        </p>
      </div>
      <p className="text-sm text-neutral-600">Tidak bisa dijual atau dipakai, dan tidak termasuk stok yang bisa dijual atau dipakai.</p>
      {rows.length === 0 ? (
        <p className="text-base text-neutral-600">Belum pernah ada barang cacat.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const canOpen = row.source.kind === "purchase" ? canOpenPurchase : canOpenBatch;
            const href = row.source.kind === "purchase" ? `/purchases/${row.source.id}` : `/production/${row.source.id}`;
            return (
              <li key={row.id} data-testid="item-defect-row">
                <Card className={`flex flex-col gap-1${row.reversedAt !== null ? " opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-base tabular-nums text-neutral-900">
                      {row.qty > 0 ? "+" : ""}
                      {formatQty(kind, row.qty)}
                      {row.valueAmount !== null && <span className="text-sm text-neutral-600"> · Nilai {formatRupiah(row.valueAmount)}</span>}
                      {row.proceedsAmount !== null && row.disposalType !== null && (
                        <span className="text-sm text-neutral-600"> · Hasil {formatRupiah(row.proceedsAmount)}</span>
                      )}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="neutral">
                        {DEFECT_MOVEMENT_TYPE_LABELS[row.type]}
                        {row.disposalType ? ` · ${DEFECT_DISPOSAL_TYPE_LABELS[row.disposalType]}` : ""}
                      </Badge>
                      {row.reversedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
                    </div>
                  </div>
                  <p className="text-sm text-neutral-600">
                    {formatDate(new Date(row.occurredAt))}
                    {" · "}
                    {canOpen ? (
                      <Link href={href} className="font-medium text-brand hover:underline">
                        {row.source.number}
                      </Link>
                    ) : (
                      row.source.number
                    )}
                  </p>
                  {row.note && row.type !== "reject" && <p className="text-sm text-neutral-800">{row.note}</p>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length === ITEM_DEFECT_LEDGER_LIMIT && (
        <p className="text-sm text-neutral-600">Menampilkan {ITEM_DEFECT_LEDGER_LIMIT} catatan terbaru.</p>
      )}
    </section>
  );
}
