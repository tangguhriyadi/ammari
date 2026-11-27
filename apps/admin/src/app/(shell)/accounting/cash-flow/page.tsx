import { Breadcrumb, EmptyState, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { parseDateRange } from "@/lib/accounting/filters";
import { statementNotes, statementPeriodLabel } from "@/lib/accounting/statement-content";
import { getCashFlow } from "@/lib/accounting/statements";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { DateField, ExportButtons, FilterForm, StatementNotes, StatementView } from "../_components/statement-view";

// Arus kas, metode langsung (docs/plans/accounting.md §6, Session 10): every movement of a cash
// account (kas, bank, Piutang Midtrans, Saldo Penjual) by its counter-account's cash-flow group
// (operasi, investasi, pendanaan). accounting.view. One set of books per range (books.ts); the
// official opening journal is the opening cash, never a cash flow of January.

type RawParams = { from?: string | string[]; to?: string | string[] };

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requirePermission("accounting.view");
  const report = await getCashFlow(parseDateRange(await searchParams, jakartaDate()));
  const { range, statement } = report;
  const empty = statement.figures.openingCash === 0 && statement.figures.closingCash === 0 && statement.figures.netChange === 0 && statement.rows.every((row) => row.style !== "account");

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/cash-flow")} />
      <PageHeader
        title="Arus Kas"
        description={`Uang masuk dan keluar menurut kegiatannya. Periode ${statementPeriodLabel(report)}.`}
        actions={<ExportButtons href={`/accounting/cash-flow/export?from=${range.from}&to=${range.to}`} />}
      />
      <FilterForm label="Filter arus kas">
        <DateField id="cash-flow-from" name="from" label="Dari tanggal" value={range.from} />
        <DateField id="cash-flow-to" name="to" label="Sampai tanggal" value={range.to} />
      </FilterForm>
      <StatementNotes notes={statementNotes(report)} />
      {empty ? (
        <EmptyState title="Belum ada kas di periode ini" description="Arus kas terisi setelah ada jurnal pada akun kas, bank, atau saldo platform." />
      ) : (
        <StatementView statement={statement} ledgerRange={`&from=${range.from}&to=${range.to}`} label="Arus kas" />
      )}
    </>
  );
}
