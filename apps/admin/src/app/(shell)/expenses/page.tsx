import { Breadcrumb, PageHeader, Tabs } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { monthToDate } from "@/lib/expenses/figures";
import { loadExpenseCategoryCatalog } from "@/lib/expense-categories/queries";
import { expenseSummaryHref, parseExpenseListParams, parseExpenseSummaryParams, parseExpensesTab, type ExpensesTab } from "@/lib/expenses/search-params";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ExpenseListSection } from "@/components/expenses/expense-list-section";
import { ProfitAndLossSummary } from "@/components/expenses/expense-summary";
import { RecordExpenseButton } from "@/components/expenses/record-expense-button";
import { recordExpenseOptions } from "@/components/expenses/record-options";

// "Biaya" (docs/plans/expense-master-data.md §3.8, session S5): operating expenses (kind
// operating) with their proofs, and "Laba rugi" (`?tab=pnl`): Laba bersih and the monthly PDF/Excel
// (owner answer D8). Gated by ads_expenses.manage + finance.view_profit (D5). Session S6 adds the
// read-only "Pengeluaran produksi" tab (`?tab=production`: a key in ExpensesTab and an entry in
// TABS) and the cash-out summary between the page header and the tabs.

const TABS: readonly { key: ExpensesTab; label: string; href: string }[] = [
  { key: "list", label: "Biaya operasional", href: "/expenses" },
  { key: "pnl", label: "Laba rugi", href: expenseSummaryHref({ period: "this_month" }, "pnl") },
];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const raw = await searchParams;
  const tab = parseExpensesTab(raw);
  const catalog = await loadExpenseCategoryCatalog();
  const record = recordExpenseOptions(catalog, "operational");

  const header = (
    <>
      <Breadcrumb items={rootCrumbs("/expenses")} />
      <PageHeader
        title="Biaya"
        description="Biaya operasional yang sudah dibayar, dengan buktinya, dan laba rugi. Biaya dihitung pada tanggal dibayar."
        actions={<RecordExpenseButton scope="operational" categories={record.categories} items={record.items} />}
      />
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <Tabs aria-label="Bagian Biaya" items={TABS.map(({ key, label, href }) => ({ label, href, isActive: key === tab }))} />
      </div>
    </>
  );

  if (tab === "pnl") {
    const now = new Date();
    return (
      <>
        {header}
        <ProfitAndLossSummary params={parseExpenseSummaryParams(raw, now)} today={monthToDate(now).to} now={now} />
      </>
    );
  }

  return (
    <>
      {header}
      <ExpenseListSection
        params={parseExpenseListParams(raw, catalog.categories, "operational")}
        categories={catalog.categories}
        page={typeof raw.page === "string" ? raw.page : undefined}
        perPage={typeof raw.perPage === "string" ? raw.perPage : undefined}
      />
    </>
  );
}
