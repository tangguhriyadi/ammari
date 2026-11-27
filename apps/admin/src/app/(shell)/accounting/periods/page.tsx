import Link from "next/link";
import { Badge, Breadcrumb, Card, CardList, PageHeader, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { closePostingsSummary } from "@/lib/accounting/close-postings-text";
import { requirePermission } from "@/lib/auth/require-permission";
import { formatDay } from "@/lib/accounting/format";
import { listPeriods, type PeriodRow } from "@/lib/accounting/periods";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PeriodActions } from "./_components/period-actions";

// Tutup buku (docs/plans/accounting.md §7, D-22, D-23, Session 4): every month from the December
// 2026 trial month, its status, the close target (10th of the next month), open posting issues and
// warnings. Read with accounting.view; closing and reopening need accounting.close (the buttons are
// hidden without it, and every action re-checks).

function StatusBadge({ row }: { row: PeriodRow }) {
  if (row.isTrial) return <Badge variant="neutral">Uji coba</Badge>;
  if (row.status === "closed") return <Badge variant="success">Ditutup</Badge>;
  if (row.overdue) return <Badge variant="danger">Lewat target</Badge>;
  return <Badge variant="warning">Terbuka</Badge>;
}

function Details({ row }: { row: PeriodRow }) {
  const lines: string[] = [];
  if (row.isTrial) lines.push("Bulan uji coba: jurnal berjalan, tidak pernah ditutup, bukan bagian dari pembukuan resmi.");
  if (row.status === "closed" && row.closedAt) lines.push(`Ditutup ${formatDateTime(row.closedAt)} WIB${row.closedByName ? ` oleh ${row.closedByName}` : ""}.`);
  if (row.closeOverrideReason) lines.push(`Ditutup dengan sumber yang belum dibukukan. Alasan: ${row.closeOverrideReason}`);
  if (row.reopenedAt) lines.push(`Terakhir dibuka kembali ${formatDateTime(row.reopenedAt)} WIB${row.reopenedByName ? ` oleh ${row.reopenedByName}` : ""}. Alasan: ${row.reopenedReason ?? ""}`);
  return (
    <div className="flex flex-col gap-1 text-sm text-neutral-600">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {!row.isTrial && row.status === "open" && row.openIssueCount > 0 && (
        <span className="text-danger-700">
          {row.openIssueCount} sumber belum bisa dibukukan.{" "}
          <Link href="/accounting/journal" className="font-medium text-brand hover:underline">
            Lihat daftar
          </Link>
        </span>
      )}
      {row.status === "open" && <ClosePostingsText row={row} />}
      {row.status === "open" &&
        row.warnings.map((warning) => (
          <span key={warning} className="text-warning-700">
            Peringatan: {warning}
          </span>
        ))}
    </div>
  );
}

function ClosePostingsText({ row }: { row: PeriodRow }) {
  return (
    <>
      {closePostingsSummary(row).map((line) => (
        <span key={line} data-testid="close-postings">
          {line}
        </span>
      ))}
    </>
  );
}

export default async function PeriodsPage() {
  const session = await requirePermission("accounting.view");
  const canClose = session.permissionKeys.includes("accounting.close");
  const rows = await listPeriods();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/periods")} />
      <PageHeader
        title="Tutup Buku"
        description="Tutup setiap bulan paling lambat tanggal 10 bulan berikutnya, setelah impor marketplace, laporan Midtrans dan pencocokan bank selesai. Bulan ditutup berurutan; membuka kembali butuh alasan tertulis."
      />
      <CardList>
        {rows.map((row) => (
          <li key={row.month} data-testid="period-card">
            <Card className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium text-neutral-900">{row.label}</span>
                  {!row.isTrial && <span className="text-sm text-neutral-600">Target tutup {formatDay(row.deadline)}</span>}
                </div>
                <StatusBadge row={row} />
              </div>
              <Details row={row} />
              {canClose && !row.isTrial && <PeriodActions month={row.month} label={row.label} status={row.status} openIssueCount={row.openIssueCount} closeRefusal={row.closeRefusal} closePostings={closePostingsSummary(row)} />}
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Bulan</Th>
          <Th>Status</Th>
          <Th>Target tutup</Th>
          <Th>Keterangan</Th>
          {canClose && <Th className="text-right">Aksi</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.month} data-testid="period-row">
              <Td className="whitespace-nowrap font-medium text-neutral-900">{row.label}</Td>
              <Td>
                <StatusBadge row={row} />
              </Td>
              <Td className="whitespace-nowrap tabular-nums">{row.isTrial ? "-" : formatDay(row.deadline)}</Td>
              <Td>
                <Details row={row} />
              </Td>
              {canClose && (
                <Td className="text-right">
                  {!row.isTrial && <PeriodActions month={row.month} label={row.label} status={row.status} openIssueCount={row.openIssueCount} closeRefusal={row.closeRefusal} closePostings={closePostingsSummary(row)} />}
                </Td>
              )}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
