import type { ReactNode } from "react";
import Link from "next/link";
import { Card, Skeleton } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { comparisonLabel, computeDelta, formatCompactRupiah, formatDeltaPercent, formatPercentBps, type Delta } from "@/lib/overview/format";
import type { ResolvedPeriod } from "@/lib/overview/period";
import { labaBersih } from "@/lib/expenses/figures";
import { expenseSummaryHref } from "@/lib/expenses/search-params";
import { getExpenseTotal } from "@/lib/expenses/summary";
import { getPeriodTotals, type PeriodMoney } from "@/lib/overview/queries";

// One row of 4 when the sales column has room for it (a container query: the "Perlu tindakan"
// aside takes part of a wide screen), 2x2 otherwise. The parent section is the @container.
const GRID = "grid grid-cols-2 gap-3 @2xl:grid-cols-4 @2xl:gap-4";
// With finance.view_profit: 5 tiles. Wide: the three sales tiles, then the two profit tiles side by
// side (a 6-column grid, spans 2 and 3); phone: 2 columns, the last tile across both.
const FINANCE_GRID = "grid grid-cols-2 gap-3 @2xl:grid-cols-6 @2xl:gap-4";
const SALES_SPAN = "@2xl:col-span-2";
const PROFIT_SPAN = "@2xl:col-span-3";
// With Laba bersih (period "Bulan ini" only, docs/plans/growth.md §4.2): 6 tiles, the three profit
// tiles span 2 like the sales tiles; phone: the two net tiles take a row each.
const NET_PROFIT_SPAN = "@2xl:col-span-2";

/** Laba bersih is shown for whole calendar months only (owner answer A3): on any shorter period
 * the day Gaji or Sewa is paid would swing it wildly, so it is hidden, never shown as 0. */
export function showsLabaBersih(period: ResolvedPeriod["period"], canViewProfit: boolean): boolean {
  return canViewProfit && period === "month";
}

/** Compact on the tile, the full amount for screen readers and on hover (§8). */
function Money({ amount }: { amount: number }) {
  return (
    <span title={formatRupiah(amount)}>
      <span aria-hidden="true">{formatCompactRupiah(amount)}</span>
      <span className="sr-only">{formatRupiah(amount)}</span>
    </span>
  );
}

/** The arrow carries the meaning, so color is never the only signal (§3.2). */
function DeltaLine({ delta, comparison }: { delta: Delta; comparison: string }) {
  if (delta.direction === "none") return <p className="text-sm text-neutral-600">Belum ada data pembanding</p>;
  if (delta.direction === "same") return <p className="text-sm text-neutral-600">Sama dengan {comparison}</p>;
  const up = delta.direction === "up";
  return (
    <p className={up ? "text-sm text-success-700" : "text-sm text-danger-700"}>
      <span aria-hidden="true">{up ? "▲" : "▼"} </span>
      <span className="sr-only">{up ? "Naik " : "Turun "}</span>
      <span className="font-medium tabular-nums">{formatDeltaPercent(delta.changeBps ?? 0)}</span> dibanding {comparison}
    </p>
  );
}

function KpiTile({
  label,
  value,
  valueClassName = "text-neutral-900",
  delta,
  comparison,
  children,
  testId,
  className,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  delta: Delta;
  comparison: string;
  children?: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <Card className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`} data-testid={testId}>
      <h3 className="text-sm font-medium text-neutral-600">{label}</h3>
      <p className={`truncate text-2xl font-semibold tabular-nums ${valueClassName}`} data-testid={`${testId}-value`}>
        {value}
      </p>
      <DeltaLine delta={delta} comparison={comparison} />
      {children}
    </Card>
  );
}

/** The fee lines of the net profit tile: what was subtracted, and which marketplace orders have no
 * fee data yet (they add 0; never estimated, owner decision 8). Non-marketplace orders never count
 * as missing: their channels have no platform fee. */
function PlatformFeeLines({ money, canViewImports }: { money: PeriodMoney; canViewImports: boolean }) {
  const fees = money.platformFees;
  if (fees.marketplaceOrders === 0) {
    return <p className="text-sm text-neutral-600" data-testid="kpi-platform-fee">Tidak ada pesanan Shopee atau TikTok Shop, jadi tidak ada biaya platform.</p>;
  }
  const missing = fees.byChannel.filter((channel) => channel.ordersWithoutFees > 0);
  const missingText = `Biaya platform belum lengkap untuk ${formatNumber(fees.ordersWithoutFees)} pesanan (${missing.map((channel) => `${channel.channelName} ${formatNumber(channel.ordersWithoutFees)}`).join(", ")})`;
  return (
    <>
      <p className="text-sm text-neutral-600 tabular-nums" data-testid="kpi-platform-fee">
        {/* Only the orders that have fee data paid into this amount; the rest are the note below. */}
        Biaya platform {formatRupiah(money.platformFee)} dari {formatNumber(fees.marketplaceOrders - fees.ordersWithoutFees)} pesanan marketplace
        {fees.byChannel.length > 1 ? ` (${fees.byChannel.map((channel) => `${channel.channelName} ${formatRupiah(channel.platformFee)}`).join(", ")})` : ""}
      </p>
      {fees.ordersWithoutFees > 0 && (
        <p className="text-sm text-warning-700" data-testid="kpi-platform-fee-incomplete">
          {canViewImports ? (
            <Link href="/import" className="underline">
              {missingText}
            </Link>
          ) : (
            missingText
          )}
        </p>
      )}
    </>
  );
}

export function OverviewKpiTilesSkeleton({ canViewProfit, showNetProfit = false }: { canViewProfit: boolean; showNetProfit?: boolean }) {
  const spans = !canViewProfit
    ? ["", ""]
    : showNetProfit
      ? [SALES_SPAN, SALES_SPAN, SALES_SPAN, NET_PROFIT_SPAN, `col-span-2 ${NET_PROFIT_SPAN}`, `col-span-2 ${NET_PROFIT_SPAN}`]
      : [SALES_SPAN, SALES_SPAN, SALES_SPAN, PROFIT_SPAN, `col-span-2 ${PROFIT_SPAN}`];
  return (
    <div className={canViewProfit ? FINANCE_GRID : GRID}>
      {spans.map((span, index) => (
        <Skeleton key={index} className={`h-28 rounded-lg ${span}`} />
      ))}
    </div>
  );
}

/**
 * The period's tiles, each against its comparison period (§3.2). Without finance.view_profit the
 * queries do not select a single money figure (D9), so only order and piece counts exist to show.
 */
export async function OverviewKpiTiles({
  resolved,
  canViewProfit,
  canViewStock,
  canViewImports = false,
  canViewExpenses = false,
}: {
  resolved: ResolvedPeriod;
  canViewProfit: boolean;
  canViewStock: boolean;
  /** orders.import: the "belum lengkap" note links to /import. */
  canViewImports?: boolean;
  /** ads_expenses.manage: Laba bersih links to the Iklan & Biaya summary. */
  canViewExpenses?: boolean;
}) {
  // Expenses are cost figures: never queried without finance.view_profit (showsLabaBersih). They
  // count by whole Jakarta days, so the comparison period includes all of its last day's expenses
  // while its orders stop at the same time of day; accepted, as expenses have no time of day.
  const showNetProfit = showsLabaBersih(resolved.period, canViewProfit);
  const [current, previous, expenses, previousExpenses] = await Promise.all([
    getPeriodTotals(resolved.current, { canViewProfit }),
    getPeriodTotals(resolved.previous, { canViewProfit }),
    showNetProfit ? getExpenseTotal({ from: resolved.fromDate, to: resolved.toDate }) : null,
    showNetProfit ? getExpenseTotal({ from: resolved.previousFromDate, to: resolved.previousToDate }) : null,
  ]);
  const comparison = comparisonLabel(resolved);
  const money = current.money;
  const previousMoney = previous.money;
  const net =
    money && previousMoney && expenses !== null && previousExpenses !== null
      ? {
          current: labaBersih({ labaSetelahBiayaPlatform: money.labaSetelahBiayaPlatform, webShippingSubsidy: money.webShippingSubsidy, expenses }),
          previous: labaBersih({ labaSetelahBiayaPlatform: previousMoney.labaSetelahBiayaPlatform, webShippingSubsidy: previousMoney.webShippingSubsidy, expenses: previousExpenses }),
          expenses,
        }
      : null;
  const profitSpan = net ? NET_PROFIT_SPAN : PROFIT_SPAN;

  return (
    <div className="flex flex-col gap-3">
      <div className={money && previousMoney ? FINANCE_GRID : GRID}>
        {money && previousMoney ? (
          <>
            <KpiTile label="Omzet" testId="kpi-omzet" className={SALES_SPAN} value={<Money amount={money.omzet} />} delta={computeDelta(money.omzet, previousMoney.omzet)} comparison={comparison} />
            <KpiTile label="Pesanan" testId="kpi-orders" className={SALES_SPAN} value={formatNumber(current.orders)} delta={computeDelta(current.orders, previous.orders)} comparison={comparison}>
              <p className="text-sm text-neutral-600 tabular-nums">{formatNumber(current.pcs)} pcs terjual</p>
            </KpiTile>
            <KpiTile
              label="Rata-rata per pesanan"
              testId="kpi-average"
              className={SALES_SPAN}
              value={<Money amount={money.averageOrderAmount ?? 0} />}
              delta={computeDelta(money.averageOrderAmount ?? 0, previousMoney.averageOrderAmount ?? 0)}
              comparison={comparison}
            />
            <KpiTile label="Laba kotor" testId="kpi-gross-profit" className={profitSpan} value={<Money amount={money.labaKotor} />} delta={computeDelta(money.labaKotor, previousMoney.labaKotor)} comparison={comparison}>
              {money.marginBps !== null && <p className="text-sm text-neutral-600 tabular-nums">Margin {formatPercentBps(money.marginBps)}</p>}
              {money.linesWithoutCost > 0 && (
                <p className="text-sm text-warning-700" data-testid="kpi-hpp-incomplete">
                  {canViewStock ? (
                    <Link href="/stock" className="underline">
                      HPP belum lengkap untuk {formatNumber(money.linesWithoutCost)} item
                    </Link>
                  ) : (
                    <>HPP belum lengkap untuk {formatNumber(money.linesWithoutCost)} item</>
                  )}
                </p>
              )}
            </KpiTile>
            <KpiTile
              label="Laba setelah biaya platform"
              testId="kpi-net-profit"
              className={`col-span-2 ${profitSpan}`}
              value={<Money amount={money.labaSetelahBiayaPlatform} />}
              delta={computeDelta(money.labaSetelahBiayaPlatform, previousMoney.labaSetelahBiayaPlatform)}
              comparison={comparison}
            >
              <PlatformFeeLines money={money} canViewImports={canViewImports} />
            </KpiTile>
            {net && (
              <KpiTile
                label="Laba bersih"
                testId="kpi-laba-bersih"
                className={`col-span-2 ${NET_PROFIT_SPAN}`}
                value={<Money amount={net.current} />}
                valueClassName={net.current >= 0 ? "text-success-700" : "text-danger-700"}
                delta={computeDelta(net.current, net.previous)}
                comparison={comparison}
              >
                <p className="text-sm text-neutral-600 tabular-nums" data-testid="kpi-laba-bersih-costs">
                  Dikurangi subsidi ongkir situs {formatRupiah(money.webShippingSubsidy)} dan biaya iklan dan operasional {formatRupiah(net.expenses)}
                </p>
                {(money.linesWithoutCost > 0 || money.platformFees.ordersWithoutFees > 0) && (
                  <p className="text-sm text-warning-700" data-testid="kpi-laba-bersih-incomplete">
                    Belum lengkap: HPP atau biaya platform di atas belum lengkap
                  </p>
                )}
                {canViewExpenses && (
                  <Link href={expenseSummaryHref({ period: "this_month" })} className="text-sm font-medium text-brand underline-offset-2 hover:underline" data-testid="kpi-laba-bersih-link">
                    Rincian di Iklan & Biaya
                  </Link>
                )}
              </KpiTile>
            )}
          </>
        ) : (
          <>
            <KpiTile label="Pesanan" testId="kpi-orders" value={formatNumber(current.orders)} delta={computeDelta(current.orders, previous.orders)} comparison={comparison} />
            <KpiTile label="Pcs terjual" testId="kpi-pcs" value={formatNumber(current.pcs)} delta={computeDelta(current.pcs, previous.pcs)} comparison={comparison} />
          </>
        )}
      </div>

      <div className="flex flex-col gap-1 text-sm text-neutral-600">
        {current.orders === 0 && <p className="font-medium text-neutral-700">Belum ada penjualan di periode ini.</p>}
        <p data-testid="kpi-undone">
          Batal: {formatNumber(current.cancelledOrders)}, Retur: {formatNumber(current.returnedOrders)}
        </p>
        {money && <p className="text-pretty">Omzet: penjualan barang setelah voucher, tanpa ongkir. Pesanan batal dan retur tidak dihitung.</p>}
        {money && (
          <p className="text-pretty" data-testid="kpi-net-profit-help">
            Laba setelah biaya platform: laba kotor dikurangi biaya Shopee dan TikTok Shop dari file impor. Hanya dua kanal itu yang punya biaya platform; pesanan kanal lain, misalnya Website dan WhatsApp, tidak punya biaya platform dan tidak dihitung belum lengkap. Biaya tidak pernah diperkirakan.
          </p>
        )}
        {net && (
          <p className="text-pretty" data-testid="kpi-laba-bersih-help">
            Laba bersih: laba setelah biaya platform, dikurangi subsidi ongkir situs dan biaya iklan dan operasional. Biaya dihitung pada tanggal dibayar. Gaji dan sewa yang
            dibayar di awal bulan masuk ke bulan itu.
          </p>
        )}
      </div>
    </div>
  );
}
