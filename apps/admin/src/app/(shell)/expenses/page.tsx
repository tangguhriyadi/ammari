import { Suspense } from "react";
import { Breadcrumb, PageHeader, Tabs } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { monthToDate } from "@/lib/expenses/figures";
import { loadExpenseCategoryCatalog } from "@/lib/expense-categories/queries";
import {
  cashSummaryMonth,
  expenseSummaryHref,
  parseExpenseListParams,
  parseExpenseSummaryParams,
  parseExpensesTab,
  parseProductionOutflowParams,
  type ExpensesTab,
} from "@/lib/expenses/search-params";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { CashOutflowSummary, CashOutflowSummarySkeleton } from "@/components/expenses/cash-outflow-summary";
import { ExpenseListSection } from "@/components/expenses/expense-list-section";
import { ProductionOutflowSection } from "@/components/expenses/production-outflow-section";
import { ProfitAndLossSummary } from "@/components/expenses/expense-summary";
import { RecordExpenseButton } from "@/components/expenses/record-expense-button";
import { recordExpenseOptions } from "@/components/expenses/record-options";

// "Biaya" (docs/plans/expense-master-data.md §3.8, session S5): operating expenses (kind
// operating) with their proofs, and "Laba rugi" (`?tab=pnl`): Laba bersih and the monthly PDF/Excel
// (owner answer D8). Gated by ads_expenses.manage + finance.view_profit (D5). Session S6 added the
// read-only "Pengeluaran produksi" tab (`?tab=production`, §3.9: supplier payments, never an
// expense) and "Arus kas keluar" (§3.10) between the page header and the tabs, following the
// month of the tab below it.

const TABS: readonly { key: ExpensesTab; label: string; href: string }[] = [
  { key: "list", label: "Biaya operasional", href: "/expenses" },
  { key: "production", label: "Pengeluaran produksi", href: "/expenses?tab=production" },
  { key: "pnl", label: "Laba rugi", href: expenseSummaryHref({ period: "this_month" }, "pnl") },
];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const raw = await searchParams;
  const tab = parseExpensesTab(raw);
  const now = new Date();
  const catalog = await loadExpenseCategoryCatalog();
  const record = recordExpenseOptions(catalog, "operational");

  const header = (
    <>
      <Breadcrumb items={rootCrumbs("/expenses")} />
      <PageHeader
        title="Biaya"
        description="Biaya operasional yang sudah dibayar, dengan buktinya, pembayaran produksi, dan laba rugi. Biaya dihitung pada tanggal dibayar."
        actions={<RecordExpenseButton scope="operational" categories={record.categories} items={record.items} />}
      />
      <Suspense fallback={<CashOutflowSummarySkeleton />}>
        <CashOutflowSummary month={cashSummaryMonth(raw, tab, now)} now={now} />
      </Suspense>
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <Tabs aria-label="Bagian Biaya" items={TABS.map(({ key, label, href }) => ({ label, href, isActive: key === tab }))} />
      </div>
    </>
  );

  if (tab === "pnl") {
    return (
      <>
        {header}
        <ProfitAndLossSummary params={parseExpenseSummaryParams(raw, now)} today={monthToDate(now).to} now={now} />
      </>
    );
  }

  if (tab === "production") {
    return (
      <>
        {header}
        <ProductionOutflowSection
          params={parseProductionOutflowParams(raw, now)}
          permissionKeys={session.permissionKeys}
          now={now}
          page={typeof raw.page === "string" ? raw.page : undefined}
          perPage={typeof raw.perPage === "string" ? raw.perPage : undefined}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <ExpenseListSection
        params={parseExpenseListParams(raw, catalog.categories, "operational", now)}
        categories={catalog.categories}
        page={typeof raw.page === "string" ? raw.page : undefined}
        perPage={typeof raw.perPage === "string" ? raw.perPage : undefined}
      />
    </>
  );
}
