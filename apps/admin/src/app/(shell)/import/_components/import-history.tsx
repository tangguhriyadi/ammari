import Link from "next/link";
import { Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { ImportBatchRow, ImportCounts } from "@/lib/marketplace-import/history";

// "Riwayat impor" (docs/plans/marketplace-import.md §11): every committed upload, newest first; a row
// opens the batch detail.

export function countsText(counts: ImportCounts | null): string {
  if (!counts) return "";
  return `${formatNumber(counts.create)} baru, ${formatNumber(counts.update)} diperbarui, ${formatNumber(counts.review)} perlu dicek`;
}

export function ImportHistory({ rows, canViewProfit }: { rows: ImportBatchRow[]; canViewProfit: boolean }) {
  if (rows.length === 0) return <EmptyState title="Belum ada impor" description="Impor yang sudah disimpan muncul di sini." />;
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/import/${row.id}`} aria-label={`Impor ${formatDateTime(row.committedAt)}, ${row.filename}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
              <Card className="flex flex-col gap-1 hover:bg-neutral-50">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-base font-semibold text-neutral-900">{formatDateTime(row.committedAt)}</span>
                  <span className="text-sm text-neutral-700">{row.channelName}</span>
                </div>
                <span className="text-sm break-all text-neutral-600">{row.filename}</span>
                <span className="text-sm text-neutral-700">{countsText(row.counts)}</span>
                <span className="text-sm text-neutral-600">
                  Oleh {row.uploadedByName}
                  {canViewProfit && row.newOmzetAmount !== null ? ` · omzet baru ${formatRupiah(row.newOmzetAmount)}` : ""}
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Waktu</Th>
          <Th>Kanal</Th>
          <Th>File</Th>
          <Th>Oleh</Th>
          <Th>Hasil</Th>
          {canViewProfit && <Th className="text-right">Omzet baru</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="whitespace-nowrap">
                <Link href={`/import/${row.id}`} className="font-medium text-neutral-900 underline underline-offset-4">
                  {formatDateTime(row.committedAt)}
                </Link>
              </Td>
              <Td className="text-neutral-700">{row.channelName}</Td>
              <Td className="max-w-56 truncate text-neutral-700" title={row.filename}>
                {row.filename}
              </Td>
              <Td className="text-neutral-700">{row.uploadedByName}</Td>
              <Td className="text-neutral-700">{countsText(row.counts)}</Td>
              {canViewProfit && <Td className="text-right tabular-nums text-neutral-700">{row.newOmzetAmount !== null ? formatRupiah(row.newOmzetAmount) : ""}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
