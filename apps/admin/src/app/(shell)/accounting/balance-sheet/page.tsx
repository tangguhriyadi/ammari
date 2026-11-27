import { Breadcrumb, EmptyState, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { parseAsOfDate } from "@/lib/accounting/filters";
import { statementNotes, statementPeriodLabel } from "@/lib/accounting/statement-content";
import { getBalanceSheet } from "@/lib/accounting/statements";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { DateField, ExportButtons, FilterForm, StatementNotes, StatementView } from "../_components/statement-view";

// Neraca / laporan posisi keuangan (docs/plans/accounting.md §6, Session 10; SAK EMKM): aset,
// kewajiban, ekuitas per tanggal, compared to the end of the previous month in the same set of books
// (books.ts; January 2027 compares to the official opening balance). accounting.view. The date lives
// in the URL (a GET form).

type RawParams = { date?: string | string[] };

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requirePermission("accounting.view");
  const asOf = parseAsOfDate(await searchParams, jakartaDate());
  const report = await getBalanceSheet(asOf);
  const empty = report.statement.rows.every((row) => row.style !== "account");

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/balance-sheet")} />
      <PageHeader
        title="Neraca"
        description={`Posisi aset, kewajiban, dan ekuitas. ${statementPeriodLabel(report)}.`}
        actions={<ExportButtons href={`/accounting/balance-sheet/export?date=${asOf}`} />}
      />
      <FilterForm label="Filter neraca">
        <DateField id="balance-sheet-date" name="date" label="Per tanggal" value={asOf} />
      </FilterForm>
      <StatementNotes notes={statementNotes(report)} />
      {empty ? (
        <EmptyState title="Belum ada saldo per tanggal ini" description="Neraca terisi setelah ada jurnal (posting otomatis, jurnal manual, atau saldo awal)." />
      ) : (
        <StatementView statement={report.statement} ledgerRange={`&from=${report.segmentStart}&to=${asOf}`} label="Neraca" />
      )}
    </>
  );
}
