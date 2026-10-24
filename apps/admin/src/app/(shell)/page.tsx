import { Suspense } from "react";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { formatDateRange } from "@/lib/overview/format";
import { periodParamsFromSearch, resolvePeriod, type OverviewPeriod } from "@/lib/overview/period";
import { OverviewKpiTiles, OverviewKpiTilesSkeleton } from "./_components/overview-kpi-tiles";
import { OverviewPeriodPicker } from "./_components/overview-period-picker";
import { OverviewTargetCard, OverviewTargetCardSkeleton } from "./_components/overview-target-card";

// Ringkasan (docs/plans/dashboard-overview.md §3, §6, §8): the page the owner opens every morning
// on the phone. Charts come in session 4, "Perlu tindakan" in session 5. Every money figure is
// gated on the session's finance.view_profit in the query layer (D9), not only here.

const SALES_HEADINGS: Record<OverviewPeriod, string> = {
  today: "Penjualan hari ini",
  yesterday: "Penjualan kemarin",
  "7d": "Penjualan 7 hari terakhir",
  month: "Penjualan bulan ini",
  custom: "Penjualan",
};

export default async function RingkasanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("overview.view");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const params = periodParamsFromSearch(await searchParams);
  const now = new Date();
  const today = jakartaDate(now);
  const resolved = resolvePeriod(params, now);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/")} />
      <PageHeader title="Ringkasan" description={`Data per ${formatDateTime(now)} WIB`} />

      <div className="flex flex-col gap-8">
        {canViewProfit && (
          <Suspense fallback={<OverviewTargetCardSkeleton />}>
            <OverviewTargetCard
              now={now}
              today={today}
              canViewProfit={canViewProfit}
              canManageSettings={session.permissionKeys.includes("settings.manage")}
            />
          </Suspense>
        )}

        <section aria-labelledby="overview-sales-heading" className="flex flex-col gap-4">
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
          <Suspense
            key={`${resolved.period}:${resolved.fromDate}:${resolved.toDate}`}
            fallback={<OverviewKpiTilesSkeleton canViewProfit={canViewProfit} />}
          >
            <OverviewKpiTiles
              resolved={resolved}
              canViewProfit={canViewProfit}
              canViewStock={session.permissionKeys.includes("stock.view")}
            />
          </Suspense>
        </section>
      </div>
    </>
  );
}
