import { Skeleton, Tabs } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { ChartCard, ChartTable } from "@/components/charts/chart-parts";
import { RankBar } from "@/components/charts/rank-bars";
import { formatCompactRupiah } from "@/lib/overview/format";
import type { PeriodParams, ResolvedPeriod } from "@/lib/overview/period";
import { getTopProducts, TOP_PRODUCTS_LIMIT, type TopProductRow, type TopVariantRow } from "@/lib/overview/queries";
import { overviewHref, type ChartParams } from "@/lib/overview/search-params";

const CHART_ID = "overview-top-products";

export function OverviewTopProductsSkeleton({ className }: { className?: string }) {
  return <Skeleton className={`h-80 rounded-lg ${className ?? ""}`} />;
}

function pcsText(pcs: number): string {
  return `${formatNumber(pcs)} pcs`;
}

/** "2 pcs, Rp 200 rb" with omzet, "2 pcs" without. */
function amountsText(row: { pcs: number; omzet: number | null }): string {
  return row.omzet === null ? pcsText(row.pcs) : `${pcsText(row.pcs)}, ${formatCompactRupiah(row.omzet)}`;
}

function variantLabel(variant: TopVariantRow): string {
  return `${variant.colorName}, ${variant.size}`;
}

/**
 * Chart 4 (§4.2): the top products of the period by pieces (or by omzet), each one opening to its
 * best variants (colour + size) in a native <details>, so no client JS. Without finance.view_profit
 * it is pieces only and no amount is selected (D9).
 */
export async function OverviewTopProducts({
  resolved,
  periodParams,
  charts,
  canViewProfit,
  className,
}: {
  resolved: ResolvedPeriod;
  periodParams: PeriodParams;
  charts: ChartParams;
  canViewProfit: boolean;
  className?: string;
}) {
  const rank = canViewProfit ? charts.top : "pcs";
  const rows = await getTopProducts(resolved.current, { canViewProfit, rank });
  const barValue = (row: { pcs: number; omzet: number | null }) => (rank === "omzet" ? (row.omzet ?? 0) : row.pcs);
  const max = Math.max(0, ...rows.map(barValue));
  const [leader] = rows;
  const summary = leader
    ? `${leader.productName} paling laku: ${amountsText(leader)}. Ketuk produk untuk melihat warna dan ukuran.`
    : "Belum ada penjualan di periode ini.";

  const actions = canViewProfit ? (
    <Tabs
      aria-label="Urutkan produk terlaris"
      items={[
        { label: "Pcs", href: overviewHref(periodParams, { ...charts, top: "pcs" }, CHART_ID), isActive: rank === "pcs" },
        { label: "Omzet", href: overviewHref(periodParams, { ...charts, top: "omzet" }, CHART_ID), isActive: rank === "omzet" },
      ]}
    />
  ) : undefined;

  return (
    <ChartCard
      id={CHART_ID}
      testId="overview-top-products"
      className={className}
      title={`Produk terlaris${rows.length === TOP_PRODUCTS_LIMIT ? ` (${TOP_PRODUCTS_LIMIT} teratas)` : ""}`}
      summary={summary}
      actions={actions}
    >
      {rows.length > 0 && (
        <>
          <ol className="flex flex-col divide-y divide-neutral-200">
            {rows.map((row, index) => (
              <ProductRow key={row.productId} row={row} position={index + 1} value={barValue(row)} max={max} />
            ))}
          </ol>
          <ChartTable
            caption="Produk terlaris"
            headers={canViewProfit ? ["Produk", "Pcs", "Omzet"] : ["Produk", "Pcs"]}
            rows={rows.flatMap((row) => [
              [row.productName, formatNumber(row.pcs), ...(row.omzet === null ? [] : [formatRupiah(row.omzet)])],
              ...row.variants.map((variant) => [
                `${row.productName}: ${variantLabel(variant)}`,
                formatNumber(variant.pcs),
                ...(variant.omzet === null ? [] : [formatRupiah(variant.omzet)]),
              ]),
            ])}
          />
        </>
      )}
    </ChartCard>
  );
}

function ProductRow({ row, position, value, max }: { row: TopProductRow; position: number; value: number; max: number }) {
  return (
    <li data-testid="overview-top-product">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-1.5 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-pretty text-sm font-medium text-neutral-900">
              <span className="tabular-nums text-neutral-600">{position}. </span>
              {row.productName}
            </span>
            <span className="shrink-0 text-sm font-semibold text-neutral-900 tabular-nums">{amountsText(row)}</span>
          </span>
          <RankBar value={value} max={max} />
          <span className="text-sm text-brand underline-offset-2 group-open:hidden">Lihat {formatNumber(row.variants.length + row.moreVariants)} varian</span>
          <span className="hidden text-sm text-brand group-open:inline">Tutup varian</span>
        </summary>
        <ul className="flex flex-col gap-1 pb-3 pl-5">
          {row.variants.map((variant) => (
            <li key={variant.sku} className="flex items-baseline justify-between gap-3 text-sm text-neutral-700">
              <span className="min-w-0">{variantLabel(variant)}</span>
              <span className="shrink-0 tabular-nums">{amountsText(variant)}</span>
            </li>
          ))}
          {row.moreVariants > 0 && <li className="text-sm text-neutral-600">dan {formatNumber(row.moreVariants)} varian lain</li>}
        </ul>
      </details>
    </li>
  );
}
