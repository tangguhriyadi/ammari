import Link from "next/link";
import { Card, Skeleton } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import type { ResolvedPeriod } from "@/lib/overview/period";
import { getVoucherPeriodStats } from "@/lib/vouchers/overview";

// Ringkasan's voucher card (docs/plans/growth.md §9.2, owner answer A6; SPEC's "Vouchers printed /
// claimed / redeemed counts"): counts only, for the period on screen, shown with customers.view
// and linking to the Voucher tab. No money: the value of active vouchers stays on the tab, for
// finance.view_profit.

export function OverviewVoucherCardSkeleton({ className }: { className?: string }) {
  return <Skeleton className={`h-36 rounded-lg ${className ?? ""}`} />;
}

export async function OverviewVoucherCard({ resolved, className }: { resolved: ResolvedPeriod; className?: string }) {
  const stats = await getVoucherPeriodStats(resolved.current);
  const items = [
    { label: "Kartu dicetak", value: stats.cardsPrinted, testId: "overview-voucher-printed" },
    { label: "Kartu diklaim", value: stats.cardsClaimed, testId: "overview-voucher-claimed" },
    { label: "Voucher dipakai", value: stats.vouchersUsed, testId: "overview-voucher-used" },
  ];
  return (
    <Card className={`flex flex-col gap-4 p-5 ${className ?? ""}`} data-testid="overview-voucher-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Kartu terima kasih dan voucher</h2>
        <Link href="/customers?tab=voucher" className="text-base font-medium text-brand hover:underline">
          Lihat voucher
        </Link>
      </div>
      <dl className="grid grid-cols-3 gap-4">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5" data-testid={item.testId}>
            <dt className="text-sm text-neutral-600">{item.label}</dt>
            <dd className="text-xl font-semibold tabular-nums text-neutral-900">{formatNumber(item.value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
