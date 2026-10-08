import Link from "next/link";
import { Badge, EmptyState } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { PurchaseListRow } from "@/lib/inventory/purchases";

const ITEM_TYPE_LABELS: Record<PurchaseListRow["itemType"], string> = { fabric: "Kain", accessory: "Aksesoris" };

export function PurchaseList({ rows }: { rows: PurchaseListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pembelian" description="Catat pembelian bahan atau aksesoris pertama." />;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id} className="rounded-lg border border-neutral-200 p-3">
          <Link href={`/purchases/${row.id}`} className="flex items-center justify-between gap-3">
            <div>
              <p className="text-base text-neutral-900">
                {row.itemName}
                <span className="ml-2 text-sm text-neutral-600">{ITEM_TYPE_LABELS[row.itemType]}</span>
                {row.voidedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
              </p>
              <p className="text-sm text-neutral-600">
                {formatDate(new Date(row.purchasedAt))}
                {row.supplier ? ` · ${row.supplier}` : ""}
                {" · "}
                {row.itemType === "fabric" ? `${row.qty.toFixed(2)} yard` : `${row.qty} pcs`}
              </p>
            </div>
            {row.totalAmountPaid !== null && (
              <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.totalAmountPaid)}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
