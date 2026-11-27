import Link from "next/link";
import { Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import type { PostingCompleteness, PostingGapStatus } from "@ammari/accounting/runner";
import { formatDay } from "@/lib/accounting/format";
import { sourceEventLabel, sourceTypeLabel } from "@/lib/accounting/labels";
import type { PnlReconciliation } from "@/lib/accounting/pnl-reconciliation";
import {
  COMPONENT_KEY_KIND,
  COMPONENT_LABELS,
  differenceLabel,
  NOT_IN_MANAGEMENT_REASON,
  type ComponentReconciliation,
} from "@/lib/accounting/pnl-reconciliation-rules";
import type { ReconciliationStatus } from "@/lib/accounting/reconciliation-rules";
import { Amount, StatusBadge } from "./status";

// Rekonsiliasi checks 4 (Laba rugi vs laporan manajemen) and 5 (kelengkapan posting),
// docs/plans/accounting.md §6.3, Session 10.

function componentStatus(row: ComponentReconciliation): ReconciliationStatus {
  if (row.difference === 0 && row.lines.every((line) => line.amount === 0)) return "ok";
  // Same order or expense, different amount: usually explained (refund, return), but worth a look.
  return row.lines.some((line) => line.cls === "amount") ? "review" : "explained";
}

function SampleLinks({ keys, kind, labels }: { keys: string[]; kind: "order" | "expense" | "none"; labels: Record<string, string> }) {
  if (keys.length === 0 || kind === "none") return null;
  return (
    <span className="flex flex-wrap gap-x-2 text-sm">
      {keys.map((key) =>
        kind === "order" ? (
          <Link key={key} href={`/orders/${key}`} className="font-medium text-brand hover:underline">
            {labels[key] ?? key.slice(0, 8)}
          </Link>
        ) : (
          // Expenses have no detail page (they live on Biaya or Iklan by category): the number to search for.
          <span key={key} className="tabular-nums text-neutral-700">
            {labels[key] ?? key.slice(0, 8)}
          </span>
        ),
      )}
    </span>
  );
}

function ComponentCard({ row, labels }: { row: ComponentReconciliation; labels: Record<string, string> }) {
  const kind = COMPONENT_KEY_KIND[row.component];
  const reason = kind === "none" ? NOT_IN_MANAGEMENT_REASON[row.component] : undefined;
  return (
    <Card className="flex flex-col gap-2" data-testid="reconciliation-pnl-component" data-component={row.component}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium text-neutral-900">{COMPONENT_LABELS[row.component]}</span>
        <StatusBadge status={componentStatus(row)} />
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
        <dt className="text-neutral-600">Laporan manajemen</dt>
        <dd className="text-right">
          <Amount value={row.management} />
        </dd>
        <dt className="text-neutral-600">Buku besar</dt>
        <dd className="text-right">
          <Amount value={row.ledger} />
        </dd>
        <dt className="font-medium text-neutral-900">Selisih</dt>
        <dd className="text-right font-medium">
          <Amount value={row.difference} />
        </dd>
      </dl>
      {row.lines.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-neutral-100 pt-2">
          {row.lines.map((line) => (
            <li key={line.cls} className="flex flex-col gap-0.5" data-testid="reconciliation-pnl-line" data-class={line.cls}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-neutral-700">
                  {kind === "none" && reason ? reason : differenceLabel(kind, line.cls)}
                  {line.count > 0 ? ` (${line.count})` : ""}
                </span>
                <span className="whitespace-nowrap">
                  <Amount value={line.amount} />
                </span>
              </div>
              <SampleLinks keys={line.sampleKeys} kind={kind} labels={labels} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PnlCheck({ report }: { report: PnlReconciliation }) {
  const shown = report.components.filter((row) => row.management !== 0 || row.ledger !== 0);
  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-1 text-base" data-testid="reconciliation-pnl-summary">
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Laba bersih laporan manajemen</span>
          <Amount value={report.managementNet} />
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Laba bersih buku besar (Laba rugi)</span>
          <Amount value={report.ledgerNet} />
        </div>
        <div className="flex justify-between gap-3 font-medium">
          <span>Selisih, dijelaskan per baris di bawah</span>
          <Amount value={report.ledgerNet - report.managementNet} />
        </div>
      </Card>
      {shown.length === 0 ? (
        <EmptyState title="Belum ada penjualan atau biaya di periode ini" description="Perbandingan muncul setelah ada pesanan, biaya, atau jurnal laba rugi." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((row) => (
            <ComponentCard key={row.component} row={row} labels={report.labels} />
          ))}
        </div>
      )}
    </div>
  );
}

const GAP_LABELS: Record<PostingGapStatus, string> = {
  missing: "Belum diposting",
  outdated: "Berubah sejak diposting",
  stale: "Jurnal tidak berlaku lagi",
  issue_unrecorded: "Masalah belum tercatat",
};

const journalHref = (sourceType: string, date: string) => `/accounting/journal?source=${encodeURIComponent(sourceType)}&from=${date}&to=${date}`;

export function CompletenessCheck({ report }: { report: PostingCompleteness }) {
  const total = report.gaps.length + report.orphans.length;
  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-1 text-base" data-testid="reconciliation-completeness-summary">
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Kejadian sumber yang diperiksa</span>
          <span className="tabular-nums">{report.checkedEvents}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Sudah dijurnal</span>
          <span className="tabular-nums">{report.posted}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Tertahan di daftar masalah posting</span>
          <span className="tabular-nums">{report.withOpenIssue}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-neutral-600">Menunggu jurnal asalnya</span>
          <span className="tabular-nums">{report.held}</span>
        </div>
        <div className="flex items-center justify-between gap-3 font-medium">
          <span>Belum lengkap</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{total}</span>
            <StatusBadge status={total === 0 ? "ok" : "mismatch"} />
          </span>
        </div>
      </Card>
      {total > 0 && (
        <>
          <p className="text-sm text-neutral-600">Jalankan &quot;Posting sekarang&quot; di Jurnal Umum. Jika masih muncul setelahnya, periksa sumbernya.</p>
          <CardList>
            {report.gaps.map((gap) => (
              <li key={`${gap.key.sourceType}|${gap.key.sourceId}|${gap.key.sourceEvent}`} data-testid="reconciliation-gap-card">
                <Card className="flex flex-col gap-1 text-base">
                  <span className="font-medium text-neutral-900">{GAP_LABELS[gap.status]}</span>
                  <span className="text-sm text-neutral-600">
                    {sourceTypeLabel(gap.key.sourceType)}
                    {sourceEventLabel(gap.key.sourceEvent) ? ` (${sourceEventLabel(gap.key.sourceEvent)!.toLowerCase()})` : ""}, {formatDay(gap.sourceDate)}
                  </span>
                </Card>
              </li>
            ))}
            {report.orphans.map((orphan) => (
              <li key={orphan.entryNo} data-testid="reconciliation-gap-card">
                <Card className="flex flex-col gap-1 text-base">
                  <span className="font-medium text-neutral-900">Jurnal tanpa sumber: {orphan.entryNo}</span>
                  <span className="text-sm text-neutral-600">
                    {sourceTypeLabel(orphan.key.sourceType)}, {formatDay(orphan.entryDate)}
                  </span>
                </Card>
              </li>
            ))}
          </CardList>
          <TableContainer>
            <caption className="sr-only">Kejadian sumber yang belum lengkap dijurnal</caption>
            <TableHead>
              <Th scope="col">Keadaan</Th>
              <Th scope="col">Sumber</Th>
              <Th scope="col">Tanggal</Th>
            </TableHead>
            <tbody>
              {report.gaps.map((gap) => (
                <Tr key={`${gap.key.sourceType}|${gap.key.sourceId}|${gap.key.sourceEvent}`} data-testid="reconciliation-gap-row">
                  <Td className="font-medium">{GAP_LABELS[gap.status]}</Td>
                  <Td>
                    <Link href={journalHref(gap.key.sourceType, gap.sourceDate)} className="hover:underline">
                      {sourceTypeLabel(gap.key.sourceType)}
                      {sourceEventLabel(gap.key.sourceEvent) ? ` (${sourceEventLabel(gap.key.sourceEvent)!.toLowerCase()})` : ""}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{formatDay(gap.sourceDate)}</Td>
                </Tr>
              ))}
              {report.orphans.map((orphan) => (
                <Tr key={orphan.entryNo} data-testid="reconciliation-gap-row">
                  <Td className="font-medium">Jurnal tanpa sumber: {orphan.entryNo}</Td>
                  <Td>
                    <Link href={journalHref(orphan.key.sourceType, orphan.entryDate)} className="hover:underline">
                      {sourceTypeLabel(orphan.key.sourceType)}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{formatDay(orphan.entryDate)}</Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </div>
  );
}
