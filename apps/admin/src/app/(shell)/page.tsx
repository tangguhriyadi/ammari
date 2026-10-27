import { Suspense } from "react";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requireOverviewOrRedirect } from "@/lib/auth/require-overview-or-redirect";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { formatDateRange } from "@/lib/overview/format";
import { DEFAULT_OVERVIEW_PERIOD, periodParamsFromSearch, resolvePeriod, type OverviewPeriod, type PeriodParams } from "@/lib/overview/period";
import { chartParamsFromSearch } from "@/lib/overview/search-params";
import { canManageSalesGoal } from "@/lib/settings/sales-goal-permissions";
import { OverviewBreakdownSkeleton, OverviewChannelBreakdown, OverviewProductTypeBreakdown } from "./_components/overview-breakdowns";
import { OverviewKpiTiles, OverviewKpiTilesSkeleton, showsLabaBersih } from "./_components/overview-kpi-tiles";
import { hasAnyNeedsAction, OverviewNeedsAction, OverviewNeedsActionSkeleton, type NeedsActionAccess } from "./_components/overview-needs-action";
import { OverviewPeriodPicker } from "./_components/overview-period-picker";
import { OverviewSalesChart, OverviewSalesChartSkeleton } from "./_components/overview-sales-chart";
import { OverviewTargetCard, OverviewTargetCardSkeleton } from "./_components/overview-target-card";
import { OverviewTopProducts, OverviewTopProductsSkeleton } from "./_components/overview-top-products";

// Ringkasan (docs/plans/dashboard-overview.md §3 to §8): the page the owner opens every morning on
// the phone. Every money figure is gated on the session's finance.view_profit in the query layer
// (D9), not only here; each "Perlu tindakan" block on its own module's permission.

const SALES_HEADINGS: Record<OverviewPeriod, string> = {
  today: "Penjualan hari ini",
  yesterday: "Penjualan kemarin",
  "7d": "Penjualan 7 hari terakhir",
  month: "Penjualan bulan ini",
  custom: "Penjualan",
};

/** Desktop rows of the main column (literal classes, so Tailwind generates them). */
const MAIN_ROWS = { 1: "xl:row-start-1", 2: "xl:row-start-2", 3: "xl:row-start-3" } as const;

export default async function RingkasanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireOverviewOrRedirect();
  const has = (key: string) => session.permissionKeys.includes(key);
  const canViewProfit = has("finance.view_profit");
  const search = await searchParams;
  const params = periodParamsFromSearch(search);
  const charts = chartParamsFromSearch(search, canViewProfit);
  const now = new Date();
  const today = jakartaDate(now);
  const resolved = resolvePeriod(params, now);
  // The period actually on screen (an invalid custom range already fell back), for chart links.
  const shownPeriod: PeriodParams = {
    period: resolved.period === DEFAULT_OVERVIEW_PERIOD ? undefined : resolved.period,
    from: resolved.fromDate,
    to: resolved.toDate,
  };
  const periodKey = `${resolved.period}:${resolved.fromDate}:${resolved.toDate}`;

  const access: NeedsActionAccess = {
    orders: has("orders.view"),
    packing: has("packing.print_cards"),
    stock: has("stock.view"),
    supplierDebt: has("inventory.view") && canViewProfit,
    production: has("production.manage"),
    profit: canViewProfit,
    // Iklan & Biaya needs both keys (docs/plans/growth.md §7); the item links there.
    expenses: has("ads_expenses.manage") && canViewProfit,
  };
  const showActions = hasAnyNeedsAction(access);

  // Phone: one column, DOM order = visual order (target, Perlu tindakan, sales, charts), so focus
  // and screen-reader order match. Desktop (xl): a two-column page, placed with explicit grid
  // positions only (the DOM order stays): the main column holds the target card, the sales section
  // and every chart; the aside holds "Perlu tindakan", sticky while scrolling, with its own scroll
  // when taller than the screen. Inside the main column, tiles and charts follow the column's own
  // width (container queries), not the viewport's, since the aside takes part of it.
  const twoColumns = showActions;
  const mainRow = (row: 1 | 2 | 3) => (twoColumns ? `xl:col-start-1 ${MAIN_ROWS[row]}` : "");
  const salesRow = canViewProfit ? 2 : 1;
  const chartsRow = canViewProfit ? 3 : 2;
  return (
    <>
      <Breadcrumb items={rootCrumbs("/")} />
      <PageHeader title="Ringkasan" description={`Data per ${formatDateTime(now)} WIB`} />

      <div className={`grid grid-cols-1 gap-8 ${twoColumns ? "xl:grid-cols-[minmax(0,1fr)_22.5rem] xl:gap-x-8" : ""}`}>
        {canViewProfit && (
          <div className={`min-w-0 ${mainRow(1)}`}>
            <Suspense fallback={<OverviewTargetCardSkeleton />}>
              <OverviewTargetCard now={now} today={today} canViewProfit={canViewProfit} canManageSettings={canManageSalesGoal(session.permissionKeys)} />
            </Suspense>
          </div>
        )}

        {showActions && (
          <div
            className={`min-w-0 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:max-h-[calc(100dvh-3rem)] xl:self-start xl:overflow-y-auto ${canViewProfit ? "xl:row-span-3" : "xl:row-span-2"}`}
          >
            <Suspense fallback={<OverviewNeedsActionSkeleton />}>
              <OverviewNeedsAction access={access} now={now} />
            </Suspense>
          </div>
        )}

        <section aria-labelledby="overview-sales-heading" className={`@container flex min-w-0 flex-col gap-4 ${mainRow(salesRow)}`}>
          <div className="flex flex-col gap-0.5">
            <h2 id="overview-sales-heading" className="text-lg font-semibold text-neutral-900">
              {SALES_HEADINGS[resolved.period]}
            </h2>
            <p className="text-sm text-neutral-600" data-testid="overview-period-range">
              {formatDateRange(resolved.fromDate, resolved.toDate)}
            </p>
          </div>
          <OverviewPeriodPicker
            resolved={resolved}
            customRequested={params.period === "custom"}
            customAttempted={Boolean(params.from || params.to)}
            today={today}
          />
          <Suspense key={periodKey} fallback={<OverviewKpiTilesSkeleton canViewProfit={canViewProfit} showNetProfit={showsLabaBersih(resolved.period, canViewProfit)} />}>
            <OverviewKpiTiles
              resolved={resolved}
              canViewProfit={canViewProfit}
              canViewStock={has("stock.view")}
              canViewImports={has("orders.import")}
              canViewExpenses={has("ads_expenses.manage")}
            />
          </Suspense>
        </section>

        {/* Omzet per hari and Produk terlaris take the column's full width; Per kanal and Per jenis
            produk sit side by side when the column is wide enough. */}
        <section aria-label="Grafik penjualan" className={`@container min-w-0 ${mainRow(chartsRow)}`}>
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2 @3xl:gap-6">
            <Suspense key={`${periodKey}:${charts.metric}`} fallback={<OverviewSalesChartSkeleton />}>
              <OverviewSalesChart
                resolved={resolved}
                periodParams={shownPeriod}
                charts={charts}
                canViewProfit={canViewProfit}
                today={today}
                className="min-w-0 @3xl:col-span-2"
              />
            </Suspense>
            <Suspense key={`${periodKey}:channels`} fallback={<OverviewBreakdownSkeleton className={canViewProfit ? "" : "@3xl:col-span-2"} />}>
              <OverviewChannelBreakdown resolved={resolved} canViewProfit={canViewProfit} className={`min-w-0 ${canViewProfit ? "" : "@3xl:col-span-2"}`} />
            </Suspense>
            {canViewProfit && (
              <Suspense key={`${periodKey}:types`} fallback={<OverviewBreakdownSkeleton />}>
                <OverviewProductTypeBreakdown resolved={resolved} className="min-w-0" />
              </Suspense>
            )}
            <Suspense key={`${periodKey}:${charts.top}`} fallback={<OverviewTopProductsSkeleton className="@3xl:col-span-2" />}>
              <OverviewTopProducts
                resolved={resolved}
                periodParams={shownPeriod}
                charts={charts}
                canViewProfit={canViewProfit}
                className="min-w-0 @3xl:col-span-2"
              />
            </Suspense>
          </div>
        </section>
      </div>
    </>
  );
}
