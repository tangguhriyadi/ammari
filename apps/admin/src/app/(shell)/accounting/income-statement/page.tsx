import { Breadcrumb, EmptyState, Label, PageHeader, Select } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { INCOME_STATEMENT_VIEWS, parseDateRange, parseIncomeStatementView } from "@/lib/accounting/filters";
import { INCOME_STATEMENT_VIEW_LABELS, statementNotes, statementPeriodLabel } from "@/lib/accounting/statement-content";
import { getIncomeStatement } from "@/lib/accounting/statements";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { DateField, ExportButtons, FilterForm, StatementNotes, StatementView } from "../_components/statement-view";

// Laba rugi (docs/plans/accounting.md §6, Session 10): penjualan − potongan − retur = penjualan
// bersih; − HPP = laba kotor; − beban usaha (Beban persediaan included, never in HPP: D-7, D-16);
// ± lain-lain; − PPh final = laba bersih. Optional columns per month or per channel. accounting.view.
// The range stays inside one set of books (books.ts); the opening journal is never a movement.

type RawParams = { from?: string | string[]; to?: string | string[]; view?: string | string[] };

export default async function IncomeStatementPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requirePermission("accounting.view");
  const raw = await searchParams;
  const view = parseIncomeStatementView(raw);
  const report = await getIncomeStatement(parseDateRange(raw, jakartaDate()), view);
  const { range } = report;
  const empty = report.statement.rows.every((row) => row.style !== "account");

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/income-statement")} />
      <PageHeader
        title="Laba Rugi"
        description={`Pendapatan, harga pokok, dan beban. Periode ${statementPeriodLabel(report)}.`}
        actions={<ExportButtons href={`/accounting/income-statement/export?from=${range.from}&to=${range.to}&view=${view}`} />}
      />
      <FilterForm label="Filter laba rugi">
        <DateField id="income-from" name="from" label="Dari tanggal" value={range.from} />
        <DateField id="income-to" name="to" label="Sampai tanggal" value={range.to} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="income-view">Kolom</Label>
          <Select id="income-view" name="view" defaultValue={view}>
            {INCOME_STATEMENT_VIEWS.map((option) => (
              <option key={option} value={option}>
                {INCOME_STATEMENT_VIEW_LABELS[option]}
              </option>
            ))}
          </Select>
        </div>
      </FilterForm>
      <StatementNotes notes={statementNotes(report)} />
      {empty ? (
        <EmptyState title="Belum ada pendapatan atau beban di periode ini" description="Laba rugi terisi setelah penjualan, biaya, atau jurnal lain dibukukan." />
      ) : (
        <StatementView statement={report.statement} ledgerRange={`&from=${range.from}&to=${range.to}`} label="Laba rugi" />
      )}
    </>
  );
}
