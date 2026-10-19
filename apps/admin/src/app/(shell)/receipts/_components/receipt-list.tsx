import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr, type BadgeVariant } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";
import type { GoodsReceiptListRow, ReceiptListStatus } from "@/lib/receipts/list";

export const RECEIPT_STATUS_LABELS: Record<ReceiptListStatus, string> = {
  active: "Diterima",
  reversed: "Dibatalkan",
  reversal: "Pembatalan",
};

const STATUS_VARIANTS: Record<ReceiptListStatus, BadgeVariant> = {
  active: "success",
  reversed: "neutral",
  reversal: "neutral",
};

const SOURCE_LABELS = { purchase: "Pembelian", production_batch: "Produksi" } as const;

function StatusBadge({ row }: { row: GoodsReceiptListRow }) {
  const label = row.status === "reversal" && row.reversesReceiptNo ? `Pembatalan ${row.reversesReceiptNo}` : RECEIPT_STATUS_LABELS[row.status];
  return <Badge variant={STATUS_VARIANTS[row.status]}>{label}</Badge>;
}

/** The source document's number, linked when the session can open it: purchases need
 * inventory.view (which this page already requires), batches need production.manage. */
function SourceLink({ row, canViewProduction }: { row: GoodsReceiptListRow; canViewProduction: boolean }) {
  const { source } = row;
  const href = source.type === "purchase" ? `/purchases/${source.id}` : canViewProduction ? `/production/${source.id}` : null;
  if (!href) return <span>{source.documentNo}</span>;
  return (
    <Link href={href} className="font-medium text-brand hover:underline">
      {source.documentNo}
    </Link>
  );
}

function supplierText(row: GoodsReceiptListRow) {
  return row.supplierNames.length > 0 ? row.supplierNames.join(", ") : "-";
}

export function ReceiptList({ rows, canViewProduction, filtered }: { rows: GoodsReceiptListRow[]; canViewProduction: boolean; filtered: boolean }) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState title="Tidak ada penerimaan yang cocok" description="Ubah atau reset filter untuk melihat penerimaan lain." />
    ) : (
      <EmptyState title="Belum ada penerimaan" description="Penerimaan muncul di sini setelah barang pembelian atau hasil produksi diterima." />
    );
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-neutral-900">{row.receiptNo}</p>
                  <p className="text-sm text-neutral-600">
                    {SOURCE_LABELS[row.source.type]} <SourceLink row={row} canViewProduction={canViewProduction} />
                  </p>
                  <p className="truncate text-sm text-neutral-600">{supplierText(row)}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge row={row} />
                  {row.hasRejects && <Badge variant="warning">Ada cacat</Badge>}
                </div>
              </div>
              <p className="text-sm text-neutral-600">
                {formatDate(new Date(row.receivedAt))} · {row.lineCount} baris
                {row.receivedByName ? ` · Diterima oleh ${row.receivedByName}` : ""}
                {row.createdByName ? ` · Dicatat ${row.createdByName}` : ""}
              </p>
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>No. penerimaan</Th>
          <Th>Tanggal terima</Th>
          <Th>Sumber</Th>
          <Th>Supplier</Th>
          <Th>Baris</Th>
          <Th>Diterima oleh</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="font-medium text-neutral-900">{row.receiptNo}</Td>
              <Td className="text-neutral-700">{formatDate(new Date(row.receivedAt))}</Td>
              <Td className="text-neutral-700">
                {SOURCE_LABELS[row.source.type]} <SourceLink row={row} canViewProduction={canViewProduction} />
              </Td>
              <Td className="text-neutral-700">{supplierText(row)}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.lineCount}</Td>
              <Td className="text-neutral-700">{row.receivedByName ?? row.createdByName ?? "-"}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge row={row} />
                  {row.hasRejects && <Badge variant="warning">Ada cacat</Badge>}
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
