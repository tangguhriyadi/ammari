"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Button, Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import type { ImportPreview as ImportPreviewData, PreviewRow } from "@/lib/marketplace-import/preview-view";
import type { UnknownSkuGroup } from "@/lib/marketplace-import/plan";

// The preview of Periksa file (docs/plans/marketplace-import.md §11). Every list renders as cards on
// phones and as a table from `md` up. Money only arrives (and so only shows) for finance staff.

export interface ImportPreviewProps {
  preview: ImportPreviewData;
  /** fileSku -> adminSku picked in this session (sent with every Periksa file / Simpan). */
  overrides: Readonly<Record<string, string>>;
  busy: boolean;
  onMatch: (group: UnknownSkuGroup) => void;
  onUnmatch: (fileSku: string) => void;
}

const SKIP_LABELS: Record<NonNullable<PreviewRow["skipReason"]>, string> = {
  unpaid: "Belum Bayar",
  undone_before_import: "Batal sebelum tercatat",
};

function rowsText(rowNumbers: readonly number[]): string {
  if (rowNumbers.length === 0) return "";
  const shown = rowNumbers.slice(0, 6).join(", ");
  return `baris ${shown}${rowNumbers.length > 6 ? ", ..." : ""}`;
}

function CountChip({ label, count, testId }: { label: string; count: number; testId: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-sm text-neutral-700" data-testid={testId}>
      {label} <span className="font-semibold tabular-nums text-neutral-900">{formatNumber(count)}</span>
    </span>
  );
}

function Section({ title, count, open, testId, children }: { title: string; count: number; open?: boolean; testId: string; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-lg border border-neutral-200" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden justify-between gap-2 px-4 py-3 text-base font-semibold text-neutral-900">
        <span>
          {title} ({formatNumber(count)})
        </span>
        <span aria-hidden="true" className="text-sm font-normal text-neutral-600 group-open:hidden">
          Lihat
        </span>
        <span aria-hidden="true" className="hidden text-sm font-normal text-neutral-600 group-open:inline">
          Tutup
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-200 p-3 md:p-4">{children}</div>
    </details>
  );
}

function ExistingLink({ row }: { row: PreviewRow }) {
  if (!row.existing) return null;
  return (
    <Link href={`/orders/${row.existing.orderId}`} className="text-sm text-neutral-900 underline underline-offset-4">
      {row.existing.manual ? `Cocok dengan pesanan manual ${row.existing.orderNo}` : row.existing.orderNo}
    </Link>
  );
}

function Reasons({ row }: { row: PreviewRow }) {
  return (
    <ul className="flex flex-col gap-1">
      {row.reasons.map((reason, index) => (
        <li key={`${reason.code}-${index}`} className="text-sm text-neutral-700">
          {reason.message}
          {reason.skuListLink && (
            <>
              {" "}
              <Link href="/stock/sku-list" className="whitespace-nowrap text-neutral-900 underline underline-offset-4">
                Buka Daftar SKU
              </Link>
            </>
          )}
          {reason.stockSku && (
            <>
              {" "}
              <Link href={`/stock?q=${encodeURIComponent(reason.stockSku)}`} className="whitespace-nowrap text-neutral-900 underline underline-offset-4">
                Lihat stok
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReviewList({ rows }: { rows: PreviewRow[] }) {
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.channelOrderNo}>
            <Card className="flex flex-col gap-1">
              <span className="font-mono text-base break-all text-neutral-900">{row.channelOrderNo}</span>
              <Reasons row={row} />
              <FileSubtotal row={row} />
              <span className="text-sm text-neutral-600">{rowsText(row.rowNumbers)}</span>
              <ExistingLink row={row} />
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>No. pesanan</Th>
          <Th>Alasan</Th>
          <Th>Baris</Th>
          <Th>Di admin</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.channelOrderNo}>
              <Td className="font-mono text-neutral-900">{row.channelOrderNo}</Td>
              <Td>
                <Reasons row={row} />
                <FileSubtotal row={row} />
              </Td>
              <Td className="text-sm text-neutral-600">{rowsText(row.rowNumbers)}</Td>
              <Td>
                <ExistingLink row={row} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

function NewList({ rows, canViewProfit }: { rows: PreviewRow[]; canViewProfit: boolean }) {
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.channelOrderNo}>
            <Card className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-base break-all text-neutral-900">{row.channelOrderNo}</span>
                {row.targetStatus && <Badge>{ORDER_STATUS_LABELS[row.targetStatus]}</Badge>}
              </div>
              <span className="text-sm text-neutral-600">
                {[row.orderedAt ? formatDateTime(new Date(row.orderedAt)) : null, `${formatNumber(row.pieces ?? 0)} pcs`, canViewProfit && row.omzetAmount !== null ? formatRupiah(row.omzetAmount) : null]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
              <RowNotes row={row} />
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>No. pesanan</Th>
          <Th>Tanggal</Th>
          <Th>Status</Th>
          <Th className="text-right">Pcs</Th>
          {canViewProfit && <Th className="text-right">Omzet</Th>}
          <Th>Catatan</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.channelOrderNo}>
              <Td className="font-mono text-neutral-900">{row.channelOrderNo}</Td>
              <Td className="whitespace-nowrap text-neutral-700">{row.orderedAt ? formatDateTime(new Date(row.orderedAt)) : ""}</Td>
              <Td>{row.targetStatus && <Badge>{ORDER_STATUS_LABELS[row.targetStatus]}</Badge>}</Td>
              <Td className="text-right tabular-nums text-neutral-700">{formatNumber(row.pieces ?? 0)}</Td>
              {canViewProfit && <Td className="text-right tabular-nums text-neutral-700">{row.omzetAmount !== null ? formatRupiah(row.omzetAmount) : ""}</Td>}
              <Td>
                <RowNotes row={row} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

/** "Subtotal Pesanan" as in the file, per row: its scope is not verified yet (plan §19.2, O1-b), so
 * it is shown for checking against the omzet, never used. Finance only (null otherwise). */
function fileSubtotalText(row: PreviewRow): string | null {
  if (!row.fileSubtotals) return null;
  return `Subtotal di file: ${row.fileSubtotals.map((amount) => formatRupiah(amount)).join(", ")}${row.fileSubtotals.length > 1 ? " (per baris)" : ""}`;
}

function FileSubtotal({ row }: { row: PreviewRow }) {
  const text = fileSubtotalText(row);
  return text ? <span className="text-sm text-neutral-600">{text}</span> : null;
}

function RowNotes({ row }: { row: PreviewRow }) {
  const subtotal = fileSubtotalText(row);
  // A new order's marketplace dates (plan §19.3) sit with its notes; an update lists them as changes.
  const notes = [...(row.action === "create" ? row.changes : []), ...row.warnings, ...row.skuMatches.map((match) => `Dicocokkan: ${match.fileSku} ke ${match.adminSku}`), ...(subtotal ? [subtotal] : [])];
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {notes.map((note, index) => (
        <li key={`${index}-${note}`} className="text-sm text-neutral-600">
          {note}
        </li>
      ))}
    </ul>
  );
}

function UpdatedList({ rows }: { rows: PreviewRow[] }) {
  const changes = (row: PreviewRow) => (
    <ul className="flex flex-col gap-0.5">
      {row.changes.map((change, index) => (
        <li key={`${index}-${change}`} className="text-sm text-neutral-700">
          {change}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.channelOrderNo}>
            <Card className="flex flex-col gap-1">
              <span className="font-mono text-base break-all text-neutral-900">{row.channelOrderNo}</span>
              <ExistingLink row={row} />
              {changes(row)}
              <RowNotes row={row} />
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>No. pesanan</Th>
          <Th>Di admin</Th>
          <Th>Perubahan</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.channelOrderNo}>
              <Td className="font-mono text-neutral-900">{row.channelOrderNo}</Td>
              <Td>
                <ExistingLink row={row} />
              </Td>
              <Td>
                {changes(row)}
                <RowNotes row={row} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

function UnknownSkus({ groups, overrides, busy, onMatch, onUnmatch, channelLabel }: { groups: UnknownSkuGroup[]; overrides: Readonly<Record<string, string>>; busy: boolean; onMatch: (group: UnknownSkuGroup) => void; onUnmatch: (fileSku: string) => void; channelLabel: string }) {
  const matched = Object.entries(overrides);
  if (groups.length === 0 && matched.length === 0) return null;
  return (
    <section aria-label="SKU tidak dikenal" className="flex flex-col gap-3 rounded-lg border border-warning-700/30 bg-warning-50 p-4" data-testid="unknown-skus">
      <h3 className="text-base font-semibold text-neutral-900">SKU tidak dikenal</h3>
      <p className="text-sm text-neutral-700">
        Barang dicocokkan hanya lewat SKU. Perbaiki SKU di {channelLabel} supaya impor berikutnya cocok otomatis. Untuk impor ini saja, pilih varian admin yang benar.
      </p>
      {groups.length > 0 && (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => (
            <li key={group.fileSku} className="flex flex-col gap-2 rounded-md bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-mono text-base break-all text-neutral-900">{group.fileSku}</span>
                {group.nameHints.length > 0 && <span className="text-sm text-neutral-600">Di file: {group.nameHints.join(", ")}</span>}
                <span className="text-sm text-neutral-600">
                  {group.orders.length} pesanan: {group.orders.slice(0, 3).map((order) => `${order.channelOrderNo} (${rowsText(order.rowNumbers)})`).join("; ")}
                  {group.orders.length > 3 ? "; ..." : ""}
                </span>
              </div>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => onMatch(group)} className="shrink-0">
                Cocokkan ke varian
              </Button>
            </li>
          ))}
        </ul>
      )}
      {matched.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Sudah dicocokkan">
          {matched.map(([fileSku, adminSku]) => (
            <li key={fileSku} className="flex flex-col gap-2 rounded-md bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm break-all text-neutral-900">
                <span className="font-mono">{fileSku}</span> dicocokkan ke <span className="font-mono">{adminSku}</span> (impor ini saja)
              </span>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => onUnmatch(fileSku)} className="shrink-0">
                Batalkan pencocokan
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Ship and complete dates from the file (plan §19.3): what Simpan fills, what the status gate keeps
 * out, and stored dates the file contradicts (never overwritten). */
function MarketplaceDates({ preview }: { preview: ImportPreviewData }) {
  const { shippedAtFills, completedAtFills, arrangedNotShipped, shippedAtMissing, conflicts } = preview.marketplaceDates;
  const channel = preview.channelLabel;
  return (
    <>
      {(shippedAtFills > 0 || completedAtFills > 0) && (
        <p className="text-sm text-neutral-700" data-testid="import-marketplace-dates">
          Waktu dari {channel} yang akan disimpan: {formatNumber(shippedAtFills)} pesanan dapat waktu kirim, {formatNumber(completedAtFills)} pesanan dapat waktu selesai.
        </p>
      )}
      {arrangedNotShipped > 0 && (
        <p className="text-sm text-neutral-700" data-testid="import-arranged-not-shipped">
          {formatNumber(arrangedNotShipped)} pesanan sudah diatur pengirimannya, belum dikirim. Waktu kirimnya disimpan setelah {channel} mencatatnya dikirim.
        </p>
      )}
      {shippedAtMissing > 0 && (
        <p className="text-sm text-warning-700" data-testid="import-ship-time-missing">
          {formatNumber(shippedAtMissing)} pesanan sudah dikirim di {channel}, tapi Waktu Pengiriman Diatur kosong di file. Pendapatannya belum bisa dibukukan sampai file berikutnya mengisi waktu itu.
        </p>
      )}
      {conflicts > 0 && (
        <p className="text-sm text-warning-700" data-testid="import-date-conflicts">
          {formatNumber(conflicts)} pesanan punya waktu kirim atau selesai di file yang berbeda dengan yang tersimpan. Yang tersimpan tidak diubah. Lihat catatan di pesanannya.
        </p>
      )}
    </>
  );
}

export function ImportPreview({ preview, overrides, busy, onMatch, onUnmatch }: ImportPreviewProps) {
  const byAction = (action: PreviewRow["action"]) => preview.rows.filter((row) => row.action === action);
  const review = byAction("review");
  const created = byAction("create");
  const updated = byAction("update");
  const skipped = byAction("skip");
  const skipCounts = new Map<string, number>();
  for (const row of skipped) if (row.skipReason) skipCounts.set(SKIP_LABELS[row.skipReason], (skipCounts.get(SKIP_LABELS[row.skipReason]) ?? 0) + 1);
  const { file, totals } = preview;
  const range = file.from && file.to ? `, ${formatDate(new Date(file.from))} sd ${formatDate(new Date(file.to))}` : "";

  return (
    <div className="flex flex-col gap-4" data-testid="import-preview">
      <div className="flex flex-col gap-2">
        <p className="text-base text-neutral-900" data-testid="import-file-summary">
          Ringkasan file: {formatNumber(file.dataRowCount)} baris, {formatNumber(file.orderCount)} pesanan{range}
        </p>
        <div className="flex flex-wrap gap-2">
          <CountChip label="Baru" count={preview.counts.create} testId="count-create" />
          <CountChip label="Diperbarui" count={preview.counts.update} testId="count-update" />
          <CountChip label="Tidak berubah" count={preview.counts.unchanged} testId="count-unchanged" />
          <CountChip label="Perlu dicek" count={preview.counts.review} testId="count-review" />
          <CountChip label="Dilewati" count={preview.counts.skip} testId="count-skip" />
        </div>
        {totals.newOrderCount > 0 && (
          <p className="text-sm text-neutral-700" data-testid="import-new-totals">
            Pesanan baru: {formatNumber(totals.newPieces)} pcs
            {preview.canViewProfit && totals.newOmzetAmount !== null && (
              <>
                , omzet {formatRupiah(totals.newOmzetAmount)}, diskon penjual {formatRupiah(totals.newVoucherAmount ?? 0)}
              </>
            )}
          </p>
        )}
        {preview.previousCommitAt && <p className="text-sm text-neutral-700">File ini sudah pernah disimpan pada {formatDateTime(new Date(preview.previousCommitAt))}.</p>}
        {preview.warnings.map((warning, index) => (
          <p key={`${index}-${warning}`} className="text-sm text-neutral-700">
            {warning}
          </p>
        ))}
        {preview.blankSkuOrderCount > 0 && (
          <p className="text-sm text-neutral-700" data-testid="import-blank-sku-count">
            {formatNumber(preview.blankSkuOrderCount)} pesanan tertahan karena SKU kosong di {preview.channelLabel}. Isi SKU penjual dari{" "}
            <Link href="/stock/sku-list" className="text-neutral-900 underline underline-offset-4">
              Daftar SKU
            </Link>
            , lalu export ulang.
          </p>
        )}
        <MarketplaceDates preview={preview} />
        {preview.unknownStatuses.length > 0 && (
          <p className="text-sm text-neutral-700">
            Status belum dikenal: {preview.unknownStatuses.map((status) => `"${status.rawStatus}" (${status.orderCount} pesanan)`).join(", ")}. Beri tahu admin teknis supaya statusnya dipasang.
          </p>
        )}
      </div>

      <UnknownSkus groups={preview.unknownSkus} overrides={overrides} busy={busy} onMatch={onMatch} onUnmatch={onUnmatch} channelLabel={preview.channelLabel} />

      {review.length > 0 && (
        <Section title="Perlu dicek" count={review.length} open testId="section-review">
          <p className="text-sm text-neutral-700">Pesanan ini tidak ikut disimpan kali ini. Pesanan lain tetap bisa disimpan.</p>
          <ReviewList rows={review} />
        </Section>
      )}

      {file.rowErrorCount > 0 && (
        <Section title="Baris tidak valid" count={file.rowErrorCount} testId="section-row-errors">
          <ul className="flex flex-col gap-1">
            {file.rowErrors.map((rowError, index) => (
              <li key={`${rowError.rowNumber}-${index}`} className="text-sm text-neutral-700">
                Baris {rowError.rowNumber}
                {rowError.columnLabel ? `, kolom ${rowError.columnLabel}` : ""}: {rowError.message}
              </li>
            ))}
          </ul>
          {file.rowErrorCount > file.rowErrors.length && <p className="text-sm text-neutral-600">Dan {formatNumber(file.rowErrorCount - file.rowErrors.length)} baris lain.</p>}
        </Section>
      )}

      {created.length > 0 && (
        <Section title="Baru" count={created.length} testId="section-create">
          <NewList rows={created} canViewProfit={preview.canViewProfit} />
        </Section>
      )}
      {updated.length > 0 && (
        <Section title="Diperbarui" count={updated.length} testId="section-update">
          <UpdatedList rows={updated} />
        </Section>
      )}
      {preview.counts.unchanged > 0 && (
        <p className="text-sm text-neutral-700" data-testid="section-unchanged">
          Tidak berubah: {formatNumber(preview.counts.unchanged)} pesanan sudah sama dengan di admin.
        </p>
      )}
      {preview.unchangedWithWarnings.length > 0 && (
        <Section title="Tidak berubah, ada catatan" count={preview.unchangedWithWarnings.length} open testId="section-unchanged-warnings">
          <ul className="flex flex-col gap-2">
            {preview.unchangedWithWarnings.map((item) => (
              <li key={item.channelOrderNo} className="flex flex-col gap-0.5 rounded-md border border-neutral-200 p-3">
                <span className="font-mono text-base break-all text-neutral-900">{item.channelOrderNo}</span>
                {item.existing && (
                  <Link href={`/orders/${item.existing.orderId}`} className="text-sm text-neutral-900 underline underline-offset-4">
                    {item.existing.orderNo}
                  </Link>
                )}
                {item.warnings.map((warning, index) => (
                  <span key={`${index}-${warning}`} className="text-sm text-neutral-700">
                    {warning}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {skipped.length > 0 && (
        <p className="text-sm text-neutral-700" data-testid="section-skip">
          Dilewati: {[...skipCounts.entries()].map(([label, count]) => `${label} ${count}`).join(", ")}
        </p>
      )}
    </div>
  );
}
