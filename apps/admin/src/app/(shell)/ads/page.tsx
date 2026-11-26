import { Breadcrumb, PageHeader, Tabs } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { monthToDate } from "@/lib/expenses/figures";
import { loadExpenseCategoryCatalog } from "@/lib/expense-categories/queries";
import { expenseSummaryHref, parseAdsTab, parseExpenseListParams, parseExpenseSummaryParams } from "@/lib/expenses/search-params";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ExpenseListSection } from "@/components/expenses/expense-list-section";
import { RoasSummary } from "@/components/expenses/expense-summary";
import { RecordExpenseButton } from "@/components/expenses/record-expense-button";
import { recordExpenseOptions } from "@/components/expenses/record-options";

// "Iklan" (docs/plans/expense-master-data.md §3.8, session S5): ad and endorse expenses (kinds ad
// + endorsement, owner answer D7) with their proofs, and the "ROAS" tab (`?tab=roas`). Gated by
// ads_expenses.manage + finance.view_profit (D5): every row is a cost figure and the proofs are
// private. Laba bersih and the monthly report live on "Biaya" (D8).

export default async function AdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const raw = await searchParams;
  const tab = parseAdsTab(raw);
  const catalog = await loadExpenseCategoryCatalog();
  const record = recordExpenseOptions(catalog, "marketing");

  const header = (
    <>
      <Breadcrumb items={rootCrumbs("/ads")} />
      <PageHeader
        title="Iklan"
        description="Biaya iklan dan endorse yang sudah dibayar, dengan buktinya, dan ROAS per kanal. Biaya dihitung pada tanggal dibayar."
        actions={<RecordExpenseButton scope="marketing" categories={record.categories} items={record.items} />}
      />
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <Tabs
          aria-label="Bagian Iklan"
          items={[
            { label: "Catatan iklan", href: "/ads", isActive: tab === "list" },
            { label: "ROAS", href: expenseSummaryHref({ period: "this_month" }, "roas"), isActive: tab === "roas" },
          ]}
        />
      </div>
    </>
  );

  if (tab === "roas") {
    const now = new Date();
    return (
      <>
        {header}
        <RoasSummary params={parseExpenseSummaryParams(raw, now)} today={monthToDate(now).to} now={now} />
      </>
    );
  }

  return (
    <>
      {header}
      <ExpenseListSection
        params={parseExpenseListParams(raw, catalog.categories, "marketing")}
        categories={catalog.categories}
        page={typeof raw.page === "string" ? raw.page : undefined}
        perPage={typeof raw.perPage === "string" ? raw.perPage : undefined}
      />
    </>
  );
}
