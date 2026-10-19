import Link from "next/link";
import { Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatDate, formatNumber } from "@ammari/ui/lib";
import type { ListBatchesRow } from "@/lib/production/queries";
import type { ProductionBatchStatus } from "@ammari/db/schema";
import { ReceiptStatusBadge } from "./receipt-status-badge";

const STATUS_LABELS: Record<ProductionBatchStatus, string> = { draft: "Draf", posted: "Diposting" };

export function BatchStatusBadge({ status }: { status: ProductionBatchStatus }) {
  return <Badge variant={status === "posted" ? "success" : "neutral"}>{STATUS_LABELS[status]}</Badge>;
}

export function ProductionBatchList({ rows }: { rows: ListBatchesRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada batch produksi" description="Buat batch baru untuk mulai mencatat produksi." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/production/${row.id}`}>
              <Card className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-base font-semibold text-neutral-900">{row.batchNo}</span>
                  <BatchStatusBadge status={row.status} />
                </div>
                <span className="text-sm text-neutral-600">
                  {formatDate(new Date(row.producedAt))} · {row.fabricName}
                </span>
                <span className="text-sm text-neutral-600">
                  {row.fabricYards !== null ? `${row.fabricYards} yard` : "—"} · {formatNumber(row.totalPcs)} pcs
                </span>
                {row.status === "posted" && (
                  <span className="flex items-center gap-2 text-sm text-neutral-600">
                    Hasil: <ReceiptStatusBadge status={row.receiptStatus} />
                  </span>
                )}
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Batch</Th>
          <Th>Tanggal</Th>
          <Th>Bahan</Th>
          <Th>Jumlah yard</Th>
          <Th>Pcs</Th>
          <Th>Status</Th>
          <Th>Penerimaan hasil</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <Link href={`/production/${row.id}`} className="font-mono font-medium text-brand hover:underline">
                  {row.batchNo}
                </Link>
              </Td>
              <Td className="text-neutral-700">{formatDate(new Date(row.producedAt))}</Td>
              <Td className="text-neutral-700">{row.fabricName}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.fabricYards !== null ? `${row.fabricYards} yard` : "—"}</Td>
              <Td className="text-neutral-700 tabular-nums">{formatNumber(row.totalPcs)}</Td>
              <Td>
                <BatchStatusBadge status={row.status} />
              </Td>
              <Td>{row.status === "posted" ? <ReceiptStatusBadge status={row.receiptStatus} /> : <span className="text-neutral-600">—</span>}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
