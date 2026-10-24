import { Skeleton, Tabs } from "@ammari/ui";
import { addCalendarDays } from "@ammari/commerce/jakarta-day";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { BarChart, type BarDatum } from "@/components/charts/bar-chart";
import { bucketKeys, fillSeries, monthOf, salesChartWindow, type SalesChartWindow, type SeriesPoint } from "@/lib/overview/charts";
import { formatCalendarDate, formatCompactAmount, formatDateRange, formatMonthShort, formatMonthYear } from "@/lib/overview/format";
import type { PeriodParams, ResolvedPeriod } from "@/lib/overview/period";
import { getSalesSeries } from "@/lib/overview/queries";
import { overviewHref, type ChartParams } from "@/lib/overview/search-params";

const CHART_ID = "overview-sales-chart";

function bucketLabel(key: string, window: SalesChartWindow): string {
  return window.granularity === "day" ? formatCalendarDate(key) : formatMonthYear(key);
}

function axisLabel(key: string, window: SalesChartWindow): string {
  return window.granularity === "day" ? String(Number(key.slice(8, 10))) : formatMonthShort(key);
}

function isSelected(key: string, window: SalesChartWindow): boolean {
  if (window.granularity === "month") return true;
  return key >= window.selectedFromDate && key <= window.selectedToDate;
}

/** A bucket that is not a whole one: today (still running), or on a monthly chart a month the range
 * covers only in part (a custom range starting or ending mid-month, or this month), so a short bar
 * never reads as a weak month. */
function isPartial(key: string, window: SalesChartWindow, today: string): boolean {
  if (window.granularity === "day") return key === today;
  const firstMonth = monthOf(window.fromDate);
  const lastMonth = monthOf(window.toDate);
  const lastDayOfLastMonth = addCalendarDays(`${addCalendarDays(lastMonth, 31).slice(0, 7)}-01`, -1);
  return (key === firstMonth && window.fromDate !== firstMonth) || (key === lastMonth && (window.toDate !== lastDayOfLastMonth || window.toDate === today));
}

function summaryText(points: readonly BarDatum[], resolved: ResolvedPeriod, window: SalesChartWindow, format: (value: number) => string): string {
  const selected = points.filter((point) => point.tone === "selected");
  const context = points.filter((point) => point.tone === "context");
  const selectedTotal = selected.reduce((sum, point) => sum + point.value, 0);

  if (context.length > 0) {
    const name = resolved.period === "today" ? "Hari ini sampai jam ini" : "Kemarin";
    const average = Math.round(context.reduce((sum, point) => sum + point.value, 0) / context.length);
    return `${name}: ${format(selectedTotal)}. Rata-rata ${formatNumber(context.length)} hari sebelumnya: ${format(average)} per hari.`;
  }
  if (selectedTotal === 0) return "Belum ada penjualan di periode ini.";
  const best = selected.reduce((top, point) => (point.value > top.value ? point : top));
  const per = window.granularity === "day" ? "hari" : "bulan";
  return `Total ${format(selectedTotal)}, ${per} tertinggi ${best.label} (${format(best.value)}).`;
}

export function OverviewSalesChartSkeleton() {
  return <Skeleton className="h-80 rounded-lg" />;
}

/**
 * Chart 1 (§4.2): omzet (or orders) per day, per month past 62 days; Hari ini / Kemarin show the 14
 * days ending on that day, the earlier days muted. Without finance.view_profit it is orders only and
 * no amount is selected (D9).
 */
export async function OverviewSalesChart({
  resolved,
  periodParams,
  charts,
  canViewProfit,
  today,
  className,
}: {
  resolved: ResolvedPeriod;
  /** The period on screen, for the Omzet / Pesanan links. */
  periodParams: PeriodParams;
  charts: ChartParams;
  canViewProfit: boolean;
  today: string;
  className?: string;
}) {
  const window = salesChartWindow(resolved);
  const showOmzet = canViewProfit && charts.metric === "omzet";
  const rows = await getSalesSeries(window.range, { canViewProfit: showOmzet, granularity: window.granularity });
  const points: SeriesPoint[] = fillSeries(bucketKeys(window.fromDate, window.toDate, window.granularity), rows, showOmzet);

  const data: BarDatum[] = points.map((point) => ({
    key: point.key,
    label: bucketLabel(point.key, window),
    axisLabel: axisLabel(point.key, window),
    value: showOmzet ? (point.omzet ?? 0) : point.orders,
    tone: isSelected(point.key, window) ? "selected" : "context",
    partial: isPartial(point.key, window, today),
  }));

  const per = window.granularity === "day" ? "per hari" : "per bulan";
  const title = showOmzet ? `Omzet ${per}` : `Pesanan ${per}`;
  const formatValue = showOmzet ? formatRupiah : (value: number) => `${formatNumber(value)} pesanan`;
  const summary = summaryText(data, resolved, window, formatValue);

  const actions = canViewProfit ? (
    <Tabs
      aria-label="Tampilkan grafik"
      items={[
        { label: "Omzet", href: overviewHref(periodParams, { ...charts, metric: "omzet" }, CHART_ID), isActive: showOmzet },
        { label: "Pesanan", href: overviewHref(periodParams, { ...charts, metric: "orders" }, CHART_ID), isActive: !showOmzet },
      ]}
    />
  ) : undefined;

  return (
    <BarChart
      id={CHART_ID}
      testId="overview-sales-chart"
      className={className}
      title={title}
      summary={summary}
      actions={actions}
      data={data}
      formatValue={formatValue}
      formatTick={showOmzet ? formatCompactAmount : formatNumber}
      integer={!showOmzet}
      labelHeader={window.granularity === "day" ? "Tanggal" : "Bulan"}
      valueHeader={showOmzet ? "Omzet" : "Pesanan"}
      footnote={formatDateRange(window.fromDate, window.toDate)}
    />
  );
}
