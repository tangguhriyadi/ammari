import { Suspense } from "react";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { formatDateRange } from "@/lib/overview/format";
import { DEFAULT_OVERVIEW_PERIOD, periodParamsFromSearch, resolvePeriod, type OverviewPeriod, type PeriodParams } from "@/lib/overview/period";
import { chartParamsFromSearch } from "@/lib/overview/search-params";
import { canManageSalesGoal } from "@/lib/settings/sales-goal-permissions";
import { OverviewBreakdownSkeleton, OverviewChannelBreakdown, OverviewProductTypeBreakdown } from "./_components/overview-breakdowns";
import { OverviewKpiTiles, OverviewKpiTilesSkeleton } from "./_components/overview-kpi-tiles";
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

export default async function RingkasanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("overview.view");
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
  };
  const showActions = hasAnyNeedsAction(access);

  // The DOM is the phone order (target, tiles, actions, charts), so focus and screen-reader order
  // match what a phone shows. Desktop only reorders with lg:order-*: the 12-column grid of §8,
  // actions beside the target card; without the card (no finance) they follow the tiles.
  return (
    <>
      <Breadcrumb items={rootCrumbs("/")} />
      <PageHeader title="Ringkasan" description={`Data per ${formatDateTime(now)} WIB`} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-x-6">
        {canViewProfit && (
          <div className="min-w-0 lg:order-1 lg:col-span-8">
            <Suspense fallback={<OverviewTargetCardSkeleton />}>
              <OverviewTargetCard now={now} today={today} canViewProfit={canViewProfit} canManageSettings={canManageSalesGoal(session.permissionKeys)} />
            </Suspense>
          </div>
        )}

        <section aria-labelledby="overview-sales-heading" className="flex min-w-0 flex-col gap-4 lg:order-3 lg:col-span-12">
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
          <Suspense key={periodKey} fallback={<OverviewKpiTilesSkeleton canViewProfit={canViewProfit} />}>
            <OverviewKpiTiles resolved={resolved} canViewProfit={canViewProfit} canViewStock={has("stock.view")} />
          </Suspense>
        </section>

        {showActions && (
          <div className={`min-w-0 ${canViewProfit ? "lg:order-2 lg:col-span-4" : "lg:order-3 lg:col-span-12"}`}>
            <Suspense fallback={<OverviewNeedsActionSkeleton />}>
              <OverviewNeedsAction access={access} now={now} />
            </Suspense>
          </div>
        )}

        <section aria-label="Grafik penjualan" className="grid min-w-0 lg:order-4 grid-cols-1 gap-4 lg:col-span-12 lg:grid-cols-12 lg:gap-6">
          <Suspense key={`${periodKey}:${charts.metric}`} fallback={<OverviewSalesChartSkeleton />}>
            <OverviewSalesChart
              resolved={resolved}
              periodParams={shownPeriod}
              charts={charts}
              canViewProfit={canViewProfit}
              today={today}
              className="min-w-0 lg:col-span-8"
            />
          </Suspense>
          <Suspense key={`${periodKey}:channels`} fallback={<OverviewBreakdownSkeleton className="lg:col-span-4" />}>
            <OverviewChannelBreakdown resolved={resolved} canViewProfit={canViewProfit} className="min-w-0 lg:col-span-4" />
          </Suspense>
          {canViewProfit && (
            <Suspense key={`${periodKey}:types`} fallback={<OverviewBreakdownSkeleton className="lg:col-span-6" />}>
              <OverviewProductTypeBreakdown resolved={resolved} className="min-w-0 lg:col-span-6" />
            </Suspense>
          )}
          <Suspense key={`${periodKey}:${charts.top}`} fallback={<OverviewTopProductsSkeleton className={canViewProfit ? "lg:col-span-6" : "lg:col-span-12"} />}>
            <OverviewTopProducts
              resolved={resolved}
              periodParams={shownPeriod}
              charts={charts}
              canViewProfit={canViewProfit}
              className={`min-w-0 ${canViewProfit ? "lg:col-span-6" : "lg:col-span-12"}`}
            />
          </Suspense>
        </section>
      </div>
    </>
  );
}
