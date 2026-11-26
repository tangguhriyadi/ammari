import Link from "next/link";
import { Button, Checkbox, Input, Label, Pagination, Select } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { expenseCategoriesInGroup, type ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import { monthToDate } from "@/lib/expenses/figures";
import { MARKETING_CHANNEL_LABELS, MARKETING_CHANNEL_OPTIONS } from "@/lib/expenses/labels";
import { listBusinessExpenses } from "@/lib/expenses/records";
import { expenseListHref, expenseMenuPath, type ExpenseListParams } from "@/lib/expenses/search-params";
import { formatDateRange } from "@/lib/overview/format";
import { ExpenseList } from "./expense-list";

// The list tab of "Iklan" ("Catatan iklan") and of "Biaya" ("Biaya operasional")
// (docs/plans/expense-master-data.md §3.8): the same filters, total, list and pagination, scoped to
// the menu's group by `params.group`. Iklan adds "Kanal". The page has already checked
// ads_expenses.manage + finance.view_profit.

const MONTH_LABEL = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });

function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
}

export async function ExpenseListSection({
  params,
  categories,
  page,
  perPage,
}: {
  params: ExpenseListParams;
  /** The whole catalog, inactive included (marked), so past expenses stay filterable. */
  categories: readonly ExpenseCategoryInfo[];
  page: string | undefined;
  perPage: string | undefined;
}) {
  const { rows, pagination, total } = await listBusinessExpenses(params, page, perPage);
  const categoryOptions = expenseCategoriesInGroup(categories, params.group);
  const marketing = params.group === "marketing";
  const basePath = expenseMenuPath(params.group);

  return (
    <>
      <div className="flex flex-col gap-3">
        <form method="GET" action={basePath} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label={marketing ? "Filter iklan" : "Filter biaya"}>
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
              {categoryOptions.map((category) => (
                <option key={category.code} value={category.code}>
                  {category.isActive ? category.name : `${category.name} (nonaktif)`}
                </option>
              ))}
            </Select>
          </div>
          {marketing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-filter-channel">Kanal</Label>
              <Select id="expense-filter-channel" name="channel" defaultValue={params.channelId ?? ""}>
                <option value="">Semua kanal</option>
                {MARKETING_CHANNEL_OPTIONS.map((key) => (
                  <option key={key} value={key}>
                    {MARKETING_CHANNEL_LABELS[key]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-q">Cari</Label>
            <Input id="expense-q" name="q" defaultValue={params.q ?? ""} placeholder={marketing ? "No. biaya, item, kampanye, catatan" : "No. biaya, item, catatan"} />
          </div>
          <Checkbox name="voided" value="1" defaultChecked={params.showVoided} label="Tampilkan yang dibatalkan" />
          <div className="flex items-center gap-3">
            <Button type="submit">Terapkan</Button>
            <Link href={basePath} className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          </div>
        </form>
        <p className="text-base text-neutral-800" data-testid="expense-total">
          Total {params.range ? formatDateRange(params.range.from, params.range.to) : monthLabel(params.month)}: <span className="font-semibold tabular-nums">{formatRupiah(total)}</span>
          {params.showVoided && <span className="text-sm text-neutral-600"> (tanpa yang dibatalkan)</span>}
        </p>
        <ExpenseList rows={rows} categories={categories} scope={params.group} />
      </div>
      <Pagination
        pagination={pagination}
        basePath={basePath}
        searchParams={{
          // The validated month, left out when it is the default (same rule as expenseListHref).
          month: params.range || params.month === monthToDate().month ? undefined : params.month,
          from: params.range?.from,
          to: params.range?.to,
          category: params.category,
          channel: marketing ? params.channelId : undefined,
          voided: params.showVoided ? "1" : undefined,
          q: params.q,
          perPage,
        }}
        itemLabel={marketing ? "iklan" : "biaya"}
      />
    </>
  );
}
