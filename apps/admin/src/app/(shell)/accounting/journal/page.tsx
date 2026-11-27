import Link from "next/link";
import { Breadcrumb, Button, Input, Label, PageHeader, Pagination, Select } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { JOURNAL_ENTRY_KINDS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { parseJournalFilters, toSearchParams, type RawJournalParams } from "@/lib/accounting/filters";
import { JOURNAL_KIND_LABELS, JOURNAL_SOURCE_TYPE_LABELS } from "@/lib/accounting/labels";
import { getPostingStatus, listJournalEntries, listOpenPostingIssues, listPostableAccounts } from "@/lib/accounting/queries";
import { JournalList } from "../_components/journal-list";
import { PostingIssues } from "../_components/posting-issues";
import { PostingStatusNotice } from "../_components/posting-status-notice";
import { RunPostingButton } from "../_components/run-posting-button";

// Jurnal umum (docs/plans/accounting.md §6, Session 2): every journal in a date range, newest
// first, filterable by source, kind and account. Read-only: journals are never edited (a wrong one
// is reversed by the engine). Filters live in the URL (a plain GET form).

export default async function JournalPage({ searchParams }: { searchParams: Promise<RawJournalParams & { page?: string; perPage?: string }> }) {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const raw = await searchParams;
  const today = jakartaDate();
  const filters = parseJournalFilters(raw, today);
  const defaults = parseJournalFilters({}, today);
  const isDefault =
    filters.from === defaults.from && filters.to === defaults.to && !filters.sourceType && !filters.kind && !filters.accountCode;

  const [{ rows, pagination }, issues, accountOptions, postingStatus] = await Promise.all([
    listJournalEntries(filters, raw.page, raw.perPage),
    listOpenPostingIssues(),
    listPostableAccounts(),
    getPostingStatus(),
  ]);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/journal")} />
      <PageHeader
        title="Jurnal Umum"
        description={
          `Jurnal dibuat otomatis dari transaksi yang dicatat aplikasi (setiap 15 menit, atau dengan Posting sekarang); jurnal manual untuk yang tidak dicatat aplikasi. ${postingStatus.summary}`
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-3">
              <Link href="/accounting/journal/new">
                <Button variant="secondary">Catat jurnal manual</Button>
              </Link>
              <RunPostingButton />
            </div>
          ) : undefined
        }
      />
      <PostingStatusNotice status={postingStatus} />
      <PostingIssues rows={issues.rows} totalCount={issues.totalCount} />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Filter jurnal">
        {raw.perPage && <input type="hidden" name="perPage" value={raw.perPage} />}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="journal-from">Dari tanggal</Label>
          <Input id="journal-from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="journal-to">Sampai tanggal</Label>
          <Input id="journal-to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="journal-source">Sumber</Label>
          <Select id="journal-source" name="source" defaultValue={filters.sourceType ?? ""}>
            <option value="">Semua</option>
            {Object.entries(JOURNAL_SOURCE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="journal-kind">Jenis</Label>
          <Select id="journal-kind" name="kind" defaultValue={filters.kind ?? ""}>
            <option value="">Semua</option>
            {JOURNAL_ENTRY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {JOURNAL_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="journal-account">Akun</Label>
          <Select id="journal-account" name="account" defaultValue={filters.accountCode ?? ""}>
            <option value="">Semua</option>
            {accountOptions.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} {account.name}
                {account.isActive ? "" : " (nonaktif)"}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit">Terapkan</Button>
          {!isDefault && (
            <Link href="/accounting/journal" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          )}
        </div>
      </form>
      <JournalList rows={rows} filtered={!isDefault} canManage={canManage} />
      <Pagination
        pagination={pagination}
        basePath="/accounting/journal"
        searchParams={{
          ...toSearchParams({ from: filters.from, to: filters.to, source: filters.sourceType, kind: filters.kind, account: filters.accountCode }),
          perPage: raw.perPage,
        }}
        itemLabel="jurnal"
      />
    </>
  );
}
