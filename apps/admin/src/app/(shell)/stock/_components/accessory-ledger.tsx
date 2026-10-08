import Link from "next/link";
import { Card, EmptyState, Pagination, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
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

function typeLabel(row: AccessoryLedgerRow) {
  if (row.type === "purchase") {
    return (
      <Link href={`/purchases/${row.id}`} className="font-medium text-brand hover:underline">
        {TYPE_LABELS[row.type]}
      </Link>
    );
  }
  return TYPE_LABELS[row.type] ?? row.type;
}

export function AccessoryLedger({
  rows,
  pagination,
  basePath,
  searchParams = {},
  canViewProfit,
}: {
  rows: AccessoryLedgerRow[];
  pagination: PaginationData;
  basePath: string;
  searchParams?: Record<string, string | undefined>;
  canViewProfit: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pergerakan" description="Belum ada pergerakan stok untuk aksesoris ini." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex items-center justify-between gap-3">
              <div>
                <p className="text-base text-neutral-900">
                  {typeLabel(row)}
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
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Tanggal</Th>
          <Th>Jenis</Th>
          <Th>Catatan</Th>
          <Th>Qty</Th>
          <Th>Saldo</Th>
          {canViewProfit && <Th>Nilai</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="text-neutral-700">
                {formatDateTime(row.createdAt)}
                {row.createdByName ? ` · ${row.createdByName}` : ""}
              </Td>
              <Td>
                {typeLabel(row)}
                {row.reason ? ` · ${REASON_LABELS[row.reason]}` : ""}
                {row.voidedAt !== null && <span className="ml-2 text-sm text-neutral-500">(dibatalkan)</span>}
              </Td>
              <Td className="text-neutral-700">
                {row.supplier ?? ""}
                {row.supplier && row.note ? " · " : ""}
                {row.note ?? ""}
                {!row.supplier && !row.note ? "—" : ""}
              </Td>
              <Td className={`tabular-nums font-medium ${row.qty >= 0 ? "text-success-700" : "text-danger-700"}`}>
                {row.qty >= 0 ? "+" : ""}
                {formatNumber(row.qty)}
              </Td>
              <Td className="text-neutral-700 tabular-nums">{formatNumber(row.runningQty)} pcs</Td>
              {canViewProfit && <Td className="text-neutral-700 tabular-nums">{formatRupiah(row.runningValueAmount)}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>

      <Pagination pagination={pagination} basePath={basePath} searchParams={searchParams} itemLabel="pergerakan" />
    </>
  );
}
