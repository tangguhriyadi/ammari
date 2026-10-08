import Link from "next/link";
import { Pagination } from "@ammari/ui";
import { formatDateTime, formatNumber, type Pagination as PaginationData } from "@ammari/ui/lib";
import type { StockLedgerRow } from "@/lib/stock/queries";
import type { StockAdjustmentReason } from "@ammari/db/schema";

const TYPE_LABELS: Record<string, string> = {
  production: "Produksi",
  sale: "Penjualan",
  return: "Retur",
  adjustment: "Penyesuaian",
};

const REASON_LABELS: Record<StockAdjustmentReason, string> = {
  recount: "Hitung ulang",
  damaged: "Rusak/cacat",
  lost: "Hilang",
  other: "Lainnya",
};

export function StockLedger({ sku, rows, pagination }: { sku: string; rows: StockLedgerRow[]; pagination: PaginationData }) {
  if (rows.length === 0) {
    return <p className="text-base text-neutral-600">Belum ada pergerakan stok untuk SKU ini.</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const href = row.productionBatchId ? `/production/${row.productionBatchId}` : null;
          return (
            <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3">
              <div>
                <p className="text-base text-neutral-900">
                  {TYPE_LABELS[row.type] ?? row.type}
                  {row.reason ? ` · ${REASON_LABELS[row.reason]}` : ""}
                </p>
                <p className="text-sm text-neutral-600">
                  {formatDateTime(row.createdAt)}
                  {row.createdByName ? ` · ${row.createdByName}` : ""}
                </p>
                {row.note && <p className="text-sm text-neutral-600">{row.note}</p>}
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className={`text-base font-semibold tabular-nums ${row.qty >= 0 ? "text-success-700" : "text-danger-700"}`}>
                  {row.qty >= 0 ? "+" : ""}
                  {formatNumber(row.qty)}
                </span>
                <span className="text-sm text-neutral-600 tabular-nums">Saldo: {formatNumber(row.runningBalance)}</span>
              </div>
              {href && (
                <Link href={href} className="text-sm text-brand hover:underline">
                  Lihat
                </Link>
              )}
            </div>
          );
        })}
      </div>
      <Pagination pagination={pagination} basePath={`/stock/${sku}`} searchParams={{}} itemLabel="pergerakan" />
    </>
  );
}
