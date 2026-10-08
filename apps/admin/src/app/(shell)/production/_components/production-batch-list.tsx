import Link from "next/link";
import { Badge, Card, EmptyState, Pagination } from "@ammari/ui";
import { formatDate, formatNumber, type Pagination as PaginationData } from "@ammari/ui/lib";
import type { ListBatchesRow } from "@/lib/production/queries";
import type { ProductionBatchStatus } from "@ammari/db/schema";

const STATUS_LABELS: Record<ProductionBatchStatus, string> = { draft: "Draf", posted: "Diposting" };

export function BatchStatusBadge({ status }: { status: ProductionBatchStatus }) {
  return <Badge variant={status === "posted" ? "success" : "neutral"}>{STATUS_LABELS[status]}</Badge>;
}

export function ProductionBatchList({
  rows,
  pagination,
  status,
}: {
  rows: ListBatchesRow[];
  pagination: PaginationData;
  status: ProductionBatchStatus | undefined;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada batch produksi" description="Buat batch baru untuk mulai mencatat produksi." />;
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
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
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <Pagination
        pagination={pagination}
        basePath="/production"
        searchParams={{ status }}
        itemLabel="batch"
      />
    </>
  );
}
