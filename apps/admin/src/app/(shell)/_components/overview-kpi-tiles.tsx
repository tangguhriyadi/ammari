import type { ReactNode } from "react";
import Link from "next/link";
import { Card, Skeleton } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { comparisonLabel, computeDelta, formatCompactRupiah, formatDeltaPercent, formatPercentBps, type Delta } from "@/lib/overview/format";
import type { ResolvedPeriod } from "@/lib/overview/period";
import { getPeriodTotals } from "@/lib/overview/queries";

// One row of 4 when the sales column has room for it (a container query: the "Perlu tindakan"
// aside takes part of a wide screen), 2x2 otherwise. The parent section is the @container.
const GRID = "grid grid-cols-2 gap-3 @2xl:grid-cols-4 @2xl:gap-4";

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
  delta,
  comparison,
  children,
  testId,
}: {
  label: string;
  value: ReactNode;
  delta: Delta;
  comparison: string;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h3 className="text-sm font-medium text-neutral-600">{label}</h3>
      <p className="truncate text-2xl font-semibold text-neutral-900 tabular-nums" data-testid={`${testId}-value`}>
        {value}
      </p>
      <DeltaLine delta={delta} comparison={comparison} />
      {children}
    </Card>
  );
}

export function OverviewKpiTilesSkeleton({ canViewProfit }: { canViewProfit: boolean }) {
  return (
    <div className={GRID}>
      {Array.from({ length: canViewProfit ? 4 : 2 }, (_, index) => (
        <Skeleton key={index} className="h-28 rounded-lg" />
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
}: {
  resolved: ResolvedPeriod;
  canViewProfit: boolean;
  canViewStock: boolean;
}) {
  const [current, previous] = await Promise.all([
    getPeriodTotals(resolved.current, { canViewProfit }),
    getPeriodTotals(resolved.previous, { canViewProfit }),
  ]);
  const comparison = comparisonLabel(resolved);
  const money = current.money;
  const previousMoney = previous.money;

  return (
    <div className="flex flex-col gap-3">
      <div className={GRID}>
        {money && previousMoney ? (
          <>
            <KpiTile label="Omzet" testId="kpi-omzet" value={<Money amount={money.omzet} />} delta={computeDelta(money.omzet, previousMoney.omzet)} comparison={comparison} />
            <KpiTile label="Pesanan" testId="kpi-orders" value={formatNumber(current.orders)} delta={computeDelta(current.orders, previous.orders)} comparison={comparison}>
              <p className="text-sm text-neutral-600 tabular-nums">{formatNumber(current.pcs)} pcs terjual</p>
            </KpiTile>
            <KpiTile
              label="Rata-rata per pesanan"
              testId="kpi-average"
              value={<Money amount={money.averageOrderAmount ?? 0} />}
              delta={computeDelta(money.averageOrderAmount ?? 0, previousMoney.averageOrderAmount ?? 0)}
              comparison={comparison}
            />
            <KpiTile label="Laba kotor" testId="kpi-gross-profit" value={<Money amount={money.labaKotor} />} delta={computeDelta(money.labaKotor, previousMoney.labaKotor)} comparison={comparison}>
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
      </div>
    </div>
  );
}
