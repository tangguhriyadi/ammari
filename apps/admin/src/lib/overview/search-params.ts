import type { PeriodParams } from "./period";

// Ringkasan's chart switches (docs/plans/dashboard-overview.md §4.2): URL params like the period,
// so a view survives a reload and a shared link. Pure. Unknown values are the default, never an
// error.

/** Chart 1: omzet (default, finance.view_profit only) or the number of orders. */
export type SalesMetric = "omzet" | "orders";
/** Produk terlaris: by pieces (default) or by omzet (finance.view_profit only). */
export type TopRank = "pcs" | "omzet";

export interface ChartParams {
  metric: SalesMetric;
  top: TopRank;
}

type SearchParamValue = string | string[] | undefined;

const first = (value: SearchParamValue) => (Array.isArray(value) ? value[0] : value);

/** Without finance.view_profit there is no omzet to show: always orders and pieces. */
export function chartParamsFromSearch(searchParams: Record<string, SearchParamValue>, canViewProfit: boolean): ChartParams {
  if (!canViewProfit) return { metric: "orders", top: "pcs" };
  return {
    metric: first(searchParams.metric) === "orders" ? "orders" : "omzet",
    top: first(searchParams.top) === "omzet" ? "omzet" : "pcs",
  };
}

/**
 * A Ringkasan link keeping the period on screen and the other switch, with one switch changed.
 * Defaults are left out, so the bare "/" stays the default view. `hash` scrolls back to the chart
 * that was tapped instead of the top of the page.
 */
export function overviewHref(period: PeriodParams, charts: ChartParams, hash?: string): string {
  const params = new URLSearchParams();
  if (period.period) params.set("period", period.period);
  if (period.period === "custom") {
    if (period.from) params.set("from", period.from);
    if (period.to) params.set("to", period.to);
  }
  if (charts.metric !== "omzet") params.set("metric", charts.metric);
  if (charts.top !== "pcs") params.set("top", charts.top);
  const query = params.toString();
  return `/${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}
