import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { formatDay } from "@/lib/accounting/format";
import type { FixedAssetListRow, FixedAssetStatus } from "@/lib/accounting/fixed-assets";

// The fixed asset register (D-19): both layouts (CardList < md, TableContainer >= md). Accumulated
// depreciation and book value follow the schedule through this month (the month's journal is dated
// its last day).

const STATUS: Record<FixedAssetStatus, { label: string; variant: "success" | "neutral" | "warning" }> = {
  active: { label: "Aktif", variant: "success" },
  fully_depreciated: { label: "Habis disusutkan", variant: "neutral" },
  disposed: { label: "Dilepas", variant: "neutral" },
  voided: { label: "Dibatalkan", variant: "warning" },
};

export function FixedAssetStatusBadge({ status }: { status: FixedAssetStatus }) {
  return <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>;
}

export function FixedAssetList({ rows }: { rows: FixedAssetListRow[] }) {
  if (rows.length === 0) return <EmptyState title="Belum ada aset tetap" description="Catat aset dengan harga perolehan di atas batas kapitalisasi." />;
  const href = (row: FixedAssetListRow) => `/accounting/fixed-assets/${row.id}`;
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid="fixed-asset-card">
            <Card className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <Link href={href(row)} className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
                  {row.name}
                </Link>
                <FixedAssetStatusBadge status={row.status} />
              </div>
              <p className="text-sm text-neutral-700">
                {row.groupLabel} · diperoleh {formatDay(row.acquisitionDate)}
              </p>
              <p className="text-sm text-neutral-700">Harga perolehan {formatRupiah(row.cost)}</p>
              <p className="text-sm text-neutral-700">Penyusutan per bulan {formatRupiah(row.monthlyAmount)}</p>
              <p className="text-sm font-medium text-neutral-900">Nilai buku {formatRupiah(row.bookValue)}</p>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Aset</Th>
          <Th>Kelompok</Th>
          <Th>Diperoleh</Th>
          <Th className="text-right">Harga perolehan</Th>
          <Th className="text-right">Per bulan</Th>
          <Th className="text-right">Akumulasi</Th>
          <Th className="text-right">Nilai buku</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid="fixed-asset-row">
              <Td>
                <Link href={href(row)} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
                <span className="block text-sm text-neutral-600">
                  {row.assetAccountCode} {row.assetAccountName}
                </span>
              </Td>
              <Td className="text-neutral-700">{row.groupLabel}</Td>
              <Td className="whitespace-nowrap tabular-nums text-neutral-700">{formatDay(row.acquisitionDate)}</Td>
              <Td className="text-right tabular-nums">{formatRupiah(row.cost)}</Td>
              <Td className="text-right tabular-nums">{formatRupiah(row.monthlyAmount)}</Td>
              <Td className="text-right tabular-nums">{formatRupiah(row.accumulated)}</Td>
              <Td className="text-right font-medium tabular-nums">{formatRupiah(row.bookValue)}</Td>
              <Td>
                <FixedAssetStatusBadge status={row.status} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
