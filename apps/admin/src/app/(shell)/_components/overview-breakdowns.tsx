import { Skeleton } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { RankBars, type RankDatum } from "@/components/charts/rank-bars";
import { shareBps } from "@/lib/overview/charts";
import { formatCompactRupiah, formatPercentBps } from "@/lib/overview/format";
import type { ResolvedPeriod } from "@/lib/overview/period";
import { getChannelBreakdown, getProductTypeBreakdown } from "@/lib/overview/queries";

const EMPTY = "Belum ada penjualan di periode ini.";

export function OverviewBreakdownSkeleton({ className }: { className?: string }) {
  return <Skeleton className={`h-64 rounded-lg ${className ?? ""}`} />;
}

/** "WhatsApp terbesar, 62% dari omzet." for the biggest row of a ranked list. */
function leaderSummary(rows: readonly { label: string; value: number }[], of: string): string {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const [leader] = rows;
  if (!leader || total === 0) return EMPTY;
  if (rows.length === 1) return `Semua dari ${leader.label}.`;
  return `${leader.label} terbesar, ${formatPercentBps(shareBps(leader.value, total))} dari ${of}.`;
}

/**
 * Chart 2 (§4.2): per channel from the order header, so the omzet sums to the tile. Without
 * finance.view_profit it ranks by orders and no amount is selected (D9).
 */
export async function OverviewChannelBreakdown({ resolved, canViewProfit, className }: { resolved: ResolvedPeriod; canViewProfit: boolean; className?: string }) {
  const rows = await getChannelBreakdown(resolved.current, { canViewProfit });
  const totalOmzet = rows.reduce((sum, row) => sum + (row.omzet ?? 0), 0);
  const totalOrders = rows.reduce((sum, row) => sum + row.orders, 0);

  const data: RankDatum[] = rows.map((row) =>
    row.omzet !== null
      ? {
          key: row.channelId,
          label: row.channelName,
          value: row.omzet,
          valueText: formatCompactRupiah(row.omzet),
          fullValueText: formatRupiah(row.omzet),
          detail: `${formatPercentBps(shareBps(row.omzet, totalOmzet))} dari omzet, ${formatNumber(row.orders)} pesanan`,
        }
      : {
          key: row.channelId,
          label: row.channelName,
          value: row.orders,
          valueText: `${formatNumber(row.orders)} pesanan`,
          fullValueText: `${formatNumber(row.orders)} pesanan`,
          detail: `${formatPercentBps(shareBps(row.orders, totalOrders))} dari pesanan, ${formatNumber(row.pcs)} pcs`,
        },
  );

  return (
    <RankBars
      id="overview-channels"
      testId="overview-channels"
      className={className}
      title="Per channel"
      summary={leaderSummary(
        data.map((datum) => ({ label: datum.label, value: datum.value })),
        canViewProfit ? "omzet" : "pesanan",
      )}
      data={data}
      headers={["Channel", canViewProfit ? "Omzet" : "Pesanan", "Keterangan"]}
      emptyText={EMPTY}
    />
  );
}

/** Chart 3 (§4.2): per product type, the voucher spread over the lines (D6) so the bars add up to
 * the omzet tile. finance.view_profit only (§6); the page does not mount it otherwise. */
export async function OverviewProductTypeBreakdown({ resolved, className }: { resolved: ResolvedPeriod; className?: string }) {
  const rows = await getProductTypeBreakdown(resolved.current, { canViewProfit: true });
  const total = rows.reduce((sum, row) => sum + (row.omzet ?? 0), 0);
  const data: RankDatum[] = rows.map((row) => {
    const omzet = row.omzet ?? 0;
    return {
      key: row.productTypeCode,
      label: row.productTypeName,
      value: omzet,
      valueText: formatCompactRupiah(omzet),
      fullValueText: formatRupiah(omzet),
      detail: `${formatPercentBps(shareBps(omzet, total))} dari omzet, ${formatNumber(row.pcs)} pcs`,
    };
  });

  return (
    <RankBars
      id="overview-product-types"
      testId="overview-product-types"
      className={className}
      title="Per jenis produk"
      summary={
        data.length > 0
          ? `${leaderSummary(
              data.map((datum) => ({ label: datum.label, value: datum.value })),
              "omzet",
            )} Voucher dibagi ke tiap barang sesuai harganya.`
          : EMPTY
      }
      data={data}
      headers={["Jenis produk", "Omzet", "Keterangan"]}
      emptyText={EMPTY}
    />
  );
}
