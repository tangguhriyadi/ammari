import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardList, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { DocumentDefectMovementRow } from "@/lib/defects/queries";
import { isOpenBatchReceiptStatus } from "@/lib/production/receipt-status";
import type { BatchReceiptLine, BatchReceiptRow, BatchReceiptSummary } from "@/lib/receipts/production";
import type { DefectBalance } from "@/lib/defects/queries";
import { DefectHistory } from "../../purchases/_components/defect-history";
import { DisposeDefectsButton, ReturnDefectsButton } from "../../purchases/_components/defect-actions";
import { ReverseReceiptButton } from "../../purchases/_components/reverse-receipt-button";
import { CloseBatchButton } from "./close-batch-button";
import { ReceiptStatusBadge } from "./receipt-status-badge";

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function variantLabel(line: Pick<BatchReceiptLine, "productName" | "colorName" | "size">): string {
  return `${line.productName} · ${line.colorName} · ${sizeLabel(line.size)}`;
}

/** "Hasil produksi" (docs/plans/suppliers-goods-receipt.md §7, S4 + S5 + S6): a posted batch's
 * output, per variant planned / received / defective (still held) / returned / released /
 * outstanding, its receipts, its defect history, and the receive / close / reverse actions plus,
 * for inventory.manage, the defect dispositions per line. Quantities for every session that can
 * open the batch; the defect VALUE only when the caller passes it (finance.view_profit). */
export function BatchOutputSection({
  batchId,
  summary,
  receipts,
  defectRows,
  defectValue,
  canReceive,
  canManage,
  pools,
}: {
  batchId: string;
  summary: BatchReceiptSummary;
  receipts: BatchReceiptRow[];
  /** Already stripped of cost for a session without finance.view_profit. */
  defectRows: DocumentDefectMovementRow[];
  /** Value still held in defect stock from this batch; null when not shown. */
  defectValue: number | null;
  canReceive: boolean;
  canManage: boolean;
  /** Each held SKU's pooled defect balance (disposal preview); empty without finance.view_profit. */
  pools: ReadonlyMap<string, DefectBalance>;
}) {
  const isOpen = isOpenBatchReceiptStatus(summary.receiptStatus);
  // Open but fully settled (some of it as defects): nothing left to receive, only to close.
  const hasOutstanding = summary.lines.some((line) => line.outstanding > 0);
  const outstandingPcs = summary.lines.reduce((sum, line) => sum + Math.max(0, line.outstanding), 0);

  return (
    <section aria-labelledby="batch-output-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="batch-output-heading" className="text-lg font-semibold text-neutral-900">
          Hasil produksi
        </h2>
        <div className="flex flex-wrap justify-end gap-2">
          {summary.reopenedAt && <Badge variant="neutral">Dibuka kembali</Badge>}
          <ReceiptStatusBadge status={summary.receiptStatus} />
        </div>
      </div>

      {isOpen && (
        <p className="text-base text-neutral-700">
          Stok barang jadi bertambah saat hasil produksi diterima, bukan saat posting. Terima hasil yang sudah selesai dan siap dijual.
        </p>
      )}

      {summary.closedAt && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
          <Row label="Ditutup" value={`${formatDateTime(summary.closedAt)}${summary.closedByName ? ` · ${summary.closedByName}` : ""}`} />
          {summary.closeReason && <Row label="Alasan" value={summary.closeReason} />}
          {summary.reopenedAt && (
            <>
              <Row label="Dibuka kembali" value={`${formatDateTime(summary.reopenedAt)}${summary.reopenedByName ? ` · ${summary.reopenedByName}` : ""}`} />
              {summary.reopenReason && <Row label="Alasan dibuka" value={summary.reopenReason} />}
            </>
          )}
        </div>
      )}

      {isOpen && !hasOutstanding && (
        <p className="text-base text-neutral-700">Semua sisa sudah diterima atau dicatat cacat. Barang cacat bisa dikembalikan ke penjahit untuk diperbaiki atau dilepas. Tutup batch jika tidak ada lagi yang ditunggu.</p>
      )}

      {isOpen && (canReceive || canManage) && (
        <div className="flex flex-wrap gap-2">
          {canReceive && hasOutstanding && (
            <Link href={`/production/${batchId}/receive`}>
              <Button>Terima hasil</Button>
            </Link>
          )}
          {canManage && <CloseBatchButton batchId={batchId} outstandingPcs={outstandingPcs} />}
        </div>
      )}

      <OutputLines
        lines={summary.lines}
        actions={
          canManage
            ? (line) =>
                line.defectHeld > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    <ReturnDefectsButton
                      sourceType="production_batch"
                      lineId={line.id}
                      itemLabel={variantLabel(line)}
                      maxQty={line.defectHeld}
                      isFabric={false}
                      documentClosed={summary.receiptStatus === "closed"}
                    />
                    <DisposeDefectsButton
                      sourceType="production_batch"
                      lineId={line.id}
                      itemLabel={variantLabel(line)}
                      maxQty={line.defectHeld}
                      isFabric={false}
                      pool={pools.get(line.sku) ?? null}
                    />
                  </div>
                ) : null
            : undefined
        }
      />

      <h3 className="mt-2 text-base font-semibold text-neutral-900">Riwayat penerimaan</h3>
      <ReceiptHistory receipts={receipts} canReverse={canManage} />

      <h3 className="mt-2 text-base font-semibold text-neutral-900">Barang cacat</h3>
      {defectValue !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
          <Row label="Nilai cacat" value={formatRupiah(defectValue)} />
        </div>
      )}
      <DefectHistory rows={defectRows} emptyText="Tidak ada barang cacat dari batch ini." canReverse={canManage} />
    </section>
  );
}

/** Rencana / Diterima / Cacat / Ditukar / Dilepas / Sisa. "Cacat" is what is STILL held in defect
 * stock (it shrinks after a return or a release). */
function OutputLines({ lines, actions }: { lines: BatchReceiptLine[]; actions?: (line: BatchReceiptLine) => ReactNode }) {
  const showActions = actions !== undefined && lines.some((line) => line.defectHeld > 0);
  const hasDefects = lines.some((line) => line.rejected !== 0);
  return (
    <>
      <CardList>
        {lines.map((line) => (
          <li key={line.id} data-testid="output-line">
            <Card className="flex flex-col gap-2">
              <p className="text-base font-medium text-neutral-900">{variantLabel(line)}</p>
              <p className="font-mono text-sm text-neutral-600">{line.sku}</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <QtyCell label="Rencana" value={line.planned} />
                <QtyCell label="Diterima" value={line.received} />
                <QtyCell label="Cacat" value={line.defectHeld} />
                <QtyCell label="Ditukar" value={line.returned} />
                <QtyCell label="Dilepas" value={line.released} />
                <QtyCell label="Sisa" value={line.outstanding} />
              </dl>
              {actions?.(line)}
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Produk</Th>
          <Th>SKU</Th>
          <Th>Rencana</Th>
          <Th>Diterima</Th>
          <Th>Cacat</Th>
          <Th>Ditukar</Th>
          <Th>Dilepas</Th>
          <Th>Sisa</Th>
          {showActions && <Th>Barang cacat</Th>}
        </TableHead>
        <tbody>
          {lines.map((line) => (
            <Tr key={line.id} data-testid="output-row">
              <Td className="font-medium text-neutral-900">{variantLabel(line)}</Td>
              <Td className="font-mono text-sm text-neutral-700">{line.sku}</Td>
              <Td className="tabular-nums text-neutral-700">{line.planned} pcs</Td>
              <Td className="tabular-nums text-neutral-700">{line.received} pcs</Td>
              <Td className="tabular-nums text-neutral-700">{line.defectHeld} pcs</Td>
              <Td className="tabular-nums text-neutral-700">{line.returned} pcs</Td>
              <Td className="tabular-nums text-neutral-700">{line.released} pcs</Td>
              <Td className="tabular-nums text-neutral-700">{line.outstanding} pcs</Td>
              {showActions && <Td>{actions?.(line)}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
      {hasDefects && (
        <p className="text-sm text-neutral-600">
          Cacat: stok cacat yang masih disimpan. Ditukar: dikembalikan ke penjahit untuk diperbaiki atau diganti. Dilepas: dilelang, dihibahkan, atau dibuang.
        </p>
      )}
    </>
  );
}

function QtyCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-neutral-600">{label}</dt>
      <dd className="tabular-nums text-neutral-900">{value} pcs</dd>
    </div>
  );
}

function ReceiptHistory({ receipts, canReverse }: { receipts: BatchReceiptRow[]; canReverse: boolean }) {
  if (receipts.length === 0) return <p className="text-base text-neutral-600">Belum ada hasil yang diterima.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {receipts.map((receipt) => (
        <li key={receipt.id} data-testid="receipt-row">
          <Card className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-medium text-neutral-900">
                {receipt.receiptNo}
                {receipt.kind === "reversal" && <span className="ml-2 text-sm font-normal text-neutral-600">Pembatalan {receipt.reversesReceiptNo}</span>}
              </p>
              {receipt.reversedAt !== null && <Badge variant="neutral">Dibatalkan</Badge>}
            </div>
            <p className="text-sm text-neutral-600">
              Diterima {formatDate(new Date(receipt.receivedAt))}
              {receipt.receivedByName ? ` oleh ${receipt.receivedByName}` : ""}
              {" · "}dicatat {formatDateTime(receipt.createdAt)}
              {receipt.createdByName ? ` oleh ${receipt.createdByName}` : ""}
            </p>
            <ul className="text-sm text-neutral-800">
              {receipt.items.map((item) => (
                <li key={item.productionBatchItemId}>
                  {item.label}: {item.qtyAccepted} pcs
                  {item.qtyRejected !== 0 && <> · ditolak (cacat) {item.qtyRejected} pcs</>}
                </li>
              ))}
            </ul>
            {receipt.note && receipt.kind === "receipt" && <p className="text-sm text-neutral-600">{receipt.note}</p>}
            {canReverse && receipt.kind === "receipt" && receipt.reversedAt === null && (
              <div>
                <ReverseReceiptButton
                  receiptId={receipt.id}
                  receiptNo={receipt.receiptNo}
                  description="Stok barang jadi yang masuk dari penerimaan ini akan dibalik. Hanya bisa dilakukan jika SKU-nya belum terjual atau disesuaikan sesudahnya."
                />
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-right text-base text-neutral-900">{value}</span>
    </div>
  );
}
