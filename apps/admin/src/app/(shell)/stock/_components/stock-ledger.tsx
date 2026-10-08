import Link from "next/link";
import { Card, EmptyState, Pagination, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
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

export function StockLedger({
  sku,
  rows,
  pagination,
  searchParams = {},
}: {
  sku: string;
  rows: StockLedgerRow[];
  pagination: PaginationData;
  searchParams?: Record<string, string | undefined>;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pergerakan" description="Belum ada pergerakan stok untuk SKU ini." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => {
          const href = row.productionBatchId ? `/production/${row.productionBatchId}` : null;
          return (
            <li key={row.id}>
              <Card className="flex items-center justify-between gap-3">
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
              </Card>
            </li>
          );
        })}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Tanggal</Th>
          <Th>Jenis</Th>
          <Th>Catatan</Th>
          <Th>Qty</Th>
          <Th>Saldo</Th>
          <Th>
            <span className="sr-only">Tautan</span>
          </Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const href = row.productionBatchId ? `/production/${row.productionBatchId}` : null;
            return (
              <Tr key={row.id}>
                <Td className="text-neutral-700">
                  {formatDateTime(row.createdAt)}
                  {row.createdByName ? ` · ${row.createdByName}` : ""}
                </Td>
                <Td className="text-neutral-700">{TYPE_LABELS[row.type] ?? row.type}</Td>
                <Td className="text-neutral-700">
                  {row.reason ? REASON_LABELS[row.reason] : ""}
                  {row.reason && row.note ? " · " : ""}
                  {row.note ?? ""}
                  {!row.reason && !row.note ? "—" : ""}
                </Td>
                <Td className={`tabular-nums font-medium ${row.qty >= 0 ? "text-success-700" : "text-danger-700"}`}>
                  {row.qty >= 0 ? "+" : ""}
                  {formatNumber(row.qty)}
                </Td>
                <Td className="text-neutral-700 tabular-nums">{formatNumber(row.runningBalance)}</Td>
                <Td>
                  {href && (
                    <Link href={href} className="text-brand hover:underline">
                      Lihat
                    </Link>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>

      <Pagination pagination={pagination} basePath={`/stock/${sku}`} searchParams={searchParams} itemLabel="pergerakan" />
    </>
  );
}
