import Link from "next/link";
import { Pagination } from "@ammari/ui";
import { formatDateTime, formatNumber, formatRupiah, type Pagination as PaginationData } from "@ammari/ui/lib";
import type { StockAdjustmentReason } from "@ammari/db/schema";
import type { AccessoryLedgerRow } from "@/lib/inventory/accessories";

const TYPE_LABELS: Record<string, string> = {
  purchase: "Pembelian",
  purchase_void: "Pembatalan pembelian",
  production: "Produksi",
  adjustment: "Penyesuaian",
};

const REASON_LABELS: Record<StockAdjustmentReason, string> = {
  recount: "Hitung ulang",
  damaged: "Rusak/cacat",
  lost: "Hilang",
  other: "Lainnya",
};

export function AccessoryLedger({
  rows,
  pagination,
  basePath,
  canViewProfit,
}: {
  rows: AccessoryLedgerRow[];
  pagination: PaginationData;
  basePath: string;
  canViewProfit: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-base text-neutral-600">Belum ada pergerakan stok untuk aksesoris ini.</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3">
            <div>
              <p className="text-base text-neutral-900">
                {/* A purchase's own detail (and its "Batalkan pembelian" button) lives only at
                    /purchases/[id] — this ledger links to it rather than duplicating a void
                    control here. */}
                {row.type === "purchase" ? (
                  <Link href={`/purchases/${row.id}`} className="font-medium text-brand hover:underline">
                    {TYPE_LABELS[row.type]}
                  </Link>
                ) : (
                  (TYPE_LABELS[row.type] ?? row.type)
                )}
                {row.reason ? ` · ${REASON_LABELS[row.reason]}` : ""}
                {row.voidedAt !== null && <span className="ml-2 text-sm text-neutral-500">(dibatalkan)</span>}
              </p>
              <p className="text-sm text-neutral-600">
                {formatDateTime(row.createdAt)}
                {row.createdByName ? ` · ${row.createdByName}` : ""}
                {row.supplier ? ` · ${row.supplier}` : ""}
              </p>
              {row.note && <p className="text-sm text-neutral-600">{row.note}</p>}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className={`text-base font-semibold tabular-nums ${row.qty >= 0 ? "text-success-700" : "text-danger-700"}`}>
                {row.qty >= 0 ? "+" : ""}
                {formatNumber(row.qty)}
              </span>
              <span className="text-sm text-neutral-600 tabular-nums">Saldo: {formatNumber(row.runningQty)} pcs</span>
              {canViewProfit && <span className="text-sm text-neutral-600 tabular-nums">Nilai: {formatRupiah(row.runningValueAmount)}</span>}
            </div>
          </div>
        ))}
      </div>
      <Pagination pagination={pagination} basePath={basePath} searchParams={{}} itemLabel="pergerakan" />
    </>
  );
}
