import Link from "next/link";
import { Breadcrumb, Button, Checkbox, Input, Label, PageHeader, Pagination, Select, Tabs } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { monthToDate } from "@/lib/expenses/figures";
import { listBusinessExpenses } from "@/lib/expenses/records";
import { EXPENSE_CATEGORY_GROUPS, EXPENSE_CATEGORY_LABELS } from "@/lib/expenses/labels";
import { expenseListHref, expenseSummaryHref, parseExpenseListParams, parseExpenseSummaryParams, parseExpenseTab } from "@/lib/expenses/search-params";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { formatDateRange } from "@/lib/overview/format";
import { ExpenseList } from "./_components/expense-list";
import { ExpenseSummary } from "./_components/expense-summary";
import { RecordExpenseButton } from "./_components/record-expense-button";

// Iklan & Biaya, "Pengeluaran" (docs/plans/growth.md §6, session S2): every ad and operating
// expense with its proof, per month. Gated by ads_expenses.manage + finance.view_profit (§7): every
// row is a cost figure and the proofs are private. "Ringkasan" (`?tab=ringkasan`, session S3): Laba
// bersih and ad spend vs omzet for whole months (expense-summary.tsx).

const MONTH_LABEL = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });

function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
}

export default async function AdsExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const raw = await searchParams;
  const tab = parseExpenseTab(raw);
  const header = (
    <>
      <Breadcrumb items={rootCrumbs("/ads-expenses")} />
      <PageHeader
        title="Iklan & Biaya"
        description="Biaya iklan dan operasional yang sudah dibayar, dengan buktinya. Biaya dihitung pada tanggal dibayar."
        actions={<RecordExpenseButton />}
      />
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <Tabs
          aria-label="Bagian Iklan & Biaya"
          items={[
            { label: "Pengeluaran", href: "/ads-expenses", isActive: tab === "expenses" },
            { label: "Ringkasan", href: expenseSummaryHref({ period: "this_month" }), isActive: tab === "summary" },
          ]}
        />
      </div>
    </>
  );

  if (tab === "summary") {
    const now = new Date();
    return (
      <>
        {header}
        <ExpenseSummary params={parseExpenseSummaryParams(raw, now)} today={monthToDate(now).to} now={now} />
      </>
    );
  }

  const params = parseExpenseListParams(raw);
  const page = typeof raw.page === "string" ? raw.page : undefined;
  const perPage = typeof raw.perPage === "string" ? raw.perPage : undefined;
  const { rows, pagination, total } = await listBusinessExpenses(params, page, perPage);
  const categoryOptions = params.group ? EXPENSE_CATEGORY_GROUPS.filter((group) => group.key === params.group) : EXPENSE_CATEGORY_GROUPS;

  return (
    <>
      {header}
      <div className="flex flex-col gap-3">
        <Tabs
          aria-label="Filter jenis biaya"
          items={[{ key: undefined, label: "Semua" }, ...EXPENSE_CATEGORY_GROUPS].map((group) => ({
            label: group.label,
            // Changing the group drops a category from another group (parseExpenseListParams).
            href: expenseListHref({ ...params, group: group.key, category: undefined }),
            isActive: group.key === params.group,
          }))}
        />
        <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" aria-label="Filter biaya">
          {params.group && <input type="hidden" name="group" value={params.group} />}
          {params.range ? (
            <div className="flex flex-col gap-1.5" data-testid="expense-range">
              <input type="hidden" name="from" value={params.range.from} />
              <input type="hidden" name="to" value={params.range.to} />
              <span className="text-sm font-medium text-neutral-700">Rentang tanggal</span>
              <span className="text-base text-neutral-900">{formatDateRange(params.range.from, params.range.to)}</span>
              <Link href={expenseListHref({ ...params, range: undefined, month: params.range.to.slice(0, 7) })} className="text-sm font-medium text-brand hover:underline">
                Lihat per bulan
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-month">Bulan</Label>
              <Input id="expense-month" name="month" type="month" defaultValue={params.month} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-filter-category">Kategori</Label>
            <Select id="expense-filter-category" name="category" defaultValue={params.category ?? ""}>
              <option value="">Semua kategori</option>
              {categoryOptions.flatMap((group) =>
                group.categories.map((key) => (
                  <option key={key} value={key}>
                    {EXPENSE_CATEGORY_LABELS[key]}
                  </option>
                )),
              )}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-q">Cari</Label>
            <Input id="expense-q" name="q" defaultValue={params.q ?? ""} placeholder="No. biaya, kampanye, catatan" />
          </div>
          <Checkbox name="voided" value="1" defaultChecked={params.showVoided} label="Tampilkan yang dibatalkan" />
          <div className="flex items-center gap-3">
            <Button type="submit">Terapkan</Button>
            <Link href="/ads-expenses" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          </div>
        </form>
        <p className="text-base text-neutral-800" data-testid="expense-total">
          Total {params.range ? formatDateRange(params.range.from, params.range.to) : monthLabel(params.month)}: <span className="font-semibold tabular-nums">{formatRupiah(total)}</span>
          {params.showVoided && <span className="text-sm text-neutral-600"> (tanpa yang dibatalkan)</span>}
        </p>
        <ExpenseList rows={rows} />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/ads-expenses"
        searchParams={{
          // The validated month, left out when it is the default (same rule as expenseListHref).
          month: params.range || params.month === monthToDate().month ? undefined : params.month,
          from: params.range?.from,
          to: params.range?.to,
          group: params.group,
          category: params.category,
          voided: params.showVoided ? "1" : undefined,
          q: params.q,
          perPage,
        }}
        itemLabel="biaya"
      />
    </>
  );
}
