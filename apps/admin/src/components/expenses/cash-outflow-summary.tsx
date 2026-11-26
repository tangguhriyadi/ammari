import Link from "next/link";
import { Skeleton } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { getCashOutflow } from "@/lib/expenses/cash-outflow";
import { expenseListHref, productionOutflowHref } from "@/lib/expenses/search-params";
import { formatMonthYear } from "@/lib/overview/format";

// "Arus kas keluar" above Biaya's tabs (docs/plans/expense-master-data.md §3.10, session S6):
// operating costs, production payments and ads for one Jakarta month, and their sum. CASH FLOW,
// not profit, so the tiles are neutral brand colours (nothing here is on or off target) and the
// subtitle points to Laba rugi for profit. The page has checked ads_expenses.manage +
// finance.view_profit.

function Tile({ label, amount, href, testId }: { label: string; amount: number; href: string; testId: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-11 flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-3 hover:border-brand hover:bg-neutral-50"
      data-testid={testId}
    >
      <span className="text-sm text-neutral-700">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-neutral-900" data-testid={`${testId}-amount`}>
        {formatRupiah(amount)}
      </span>
    </Link>
  );
}

/** The page wraps CashOutflowSummary in Suspense with this, so the tabs and list stream first. */
export function CashOutflowSummarySkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4" aria-hidden="true">
      <Skeleton className="h-6 w-56" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}

export async function CashOutflowSummary({ month, now }: { month: string; now: Date }) {
  const cash = await getCashOutflow(month);
  const label = formatMonthYear(month);
  return (
    <section aria-labelledby="cash-outflow-heading" className="mb-6 flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4" data-testid="cash-outflow-summary">
      <div className="flex flex-col gap-0.5">
        <h2 id="cash-outflow-heading" className="text-lg font-semibold text-neutral-900">
          Arus kas keluar {label}
        </h2>
        <p className="text-sm text-neutral-700">Informasi arus kas, bukan laba. Laba bersih ada di tab Laba rugi.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Biaya operasional" amount={cash.operating} href={expenseListHref({ month, group: "operational", showVoided: false }, now)} testId="cash-operating" />
        <Tile label="Pengeluaran produksi" amount={cash.production} href={productionOutflowHref({ month }, now)} testId="cash-production" />
        <Tile label="Iklan & endorse" amount={cash.ads} href={expenseListHref({ month, group: "marketing", showVoided: false }, now)} testId="cash-ads" />
        <div className="flex flex-col gap-1 rounded-lg border border-neutral-900 bg-white p-3" data-testid="cash-total">
          <span className="text-sm font-medium text-neutral-900">Total uang keluar</span>
          <span className="text-lg font-semibold tabular-nums text-neutral-900" data-testid="cash-total-amount">
            {formatRupiah(cash.total)}
          </span>
        </div>
      </div>
      <p className="text-sm text-neutral-600">Termasuk biaya yang dibayar dari saldo penjual Shopee/TikTok.</p>
    </section>
  );
}
