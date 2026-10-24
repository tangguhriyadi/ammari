import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Card, Skeleton, type BadgeVariant } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { calendarDaysBetween } from "@ammari/commerce/jakarta-day";
import { CumulativeLine } from "@/components/charts/cumulative-line";
import { ProgressBar } from "@/components/charts/progress-bar";
import type { CumulativePoint } from "@/lib/overview/charts";
import type { GoalPace, GoalProgress } from "@/lib/overview/goal";
import { formatCalendarDate, formatCompactAmount, formatMonthShort, formatMonthYear, formatPercentBps } from "@/lib/overview/format";
import { getGoalCumulative, getGoalProgress } from "@/lib/overview/queries";

type StartedGoal = Extract<GoalProgress, { state: "active" | "ended" }>;

const STATUS_BADGE: Record<GoalPace["status"], { label: string; variant: BadgeVariant }> = {
  reached: { label: "Target tercapai", variant: "success" },
  on_track: { label: "Sesuai target", variant: "success" },
  behind: { label: "Di bawah target", variant: "danger" },
};

function CardFrame({ badge, subtitle, children }: { badge?: ReactNode; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="overview-target-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg font-semibold text-neutral-900">Target penjualan</h2>
          {subtitle && <p className="text-sm text-neutral-600">{subtitle}</p>}
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

/** basis points of `part / whole`, for bar widths; clamped to 0..10000. */
function barBps(part: number, whole: number): number {
  return Math.min(Math.max(Math.floor((part * 10_000) / whole), 0), 10_000);
}

/** Progress with a marker where a straight line to the target stands today (§2.3, D4). */
function GoalProgressBar({ progress }: { progress: StartedGoal }) {
  const expectedBps = barBps(progress.expectedAmount, progress.targetAmount);
  return (
    <div className="flex flex-col gap-1.5">
      <ProgressBar
        label="Progres target"
        valueBps={barBps(progress.actualAmount, progress.targetAmount)}
        markerBps={progress.state === "active" ? expectedBps : undefined}
        valueText={`${formatPercentBps(progress.progressBps)} tercapai, seharusnya ${formatPercentBps(expectedBps)} hari ini`}
      />
      {progress.state === "active" && (
        <p className="text-sm text-neutral-600">
          Garis hitam: posisi seharusnya hari ini ({formatPercentBps(expectedBps)}).
        </p>
      )}
    </div>
  );
}

function GoalCumulativeChart({ points, today }: { points: readonly CumulativePoint[]; today: string }) {
  const current = [...points].reverse().find((point) => point.actual !== null);
  const summary = current
    ? `Sampai ${formatMonthYear(current.month)}: ${formatRupiah(current.actual ?? 0)}, garis target di akhir bulan itu ${formatRupiah(current.expected)}.`
    : `Belum ada bulan berjalan per ${formatCalendarDate(today)}.`;
  return (
    <CumulativeLine
      id="overview-target-cumulative"
      title="Omzet kumulatif per bulan"
      summary={summary}
      data={points.map((point) => ({
        key: point.month,
        label: formatMonthYear(point.month),
        axisLabel: formatMonthShort(point.month),
        expected: point.expected,
        actual: point.actual,
      }))}
      formatValue={formatRupiah}
      formatTick={formatCompactAmount}
    />
  );
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-base font-semibold text-neutral-900 tabular-nums">{value}</dd>
    </div>
  );
}

function PaceDetails({ progress }: { progress: StartedGoal }) {
  const aheadAmount = progress.actualAmount - progress.expectedAmount;
  return (
    <>
      {progress.status === "behind" ? (
        <p className="text-base text-danger-700" data-testid="overview-target-gap">
          Kurang {formatRupiah(progress.gapAmount)} dari target hari ini
        </p>
      ) : progress.status === "on_track" ? (
        <p className="text-base text-success-700">Lebih {formatRupiah(aheadAmount)} dari target hari ini</p>
      ) : null}
      {progress.neededPerDay !== null && progress.neededPerMonth !== null && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-neutral-200 pt-4 sm:grid-cols-4">
          <Stat
            label="Perlu per hari"
            testId="overview-target-needed-day"
            value={
              <>
                {formatRupiah(progress.neededPerDay)}
                {progress.neededPcsPerDay !== null && (
                  <span className="block text-sm font-normal text-neutral-600">± {formatNumber(progress.neededPcsPerDay)} pcs</span>
                )}
              </>
            }
          />
          <Stat label="Perlu per bulan" testId="overview-target-needed-month" value={`± ${formatRupiah(progress.neededPerMonth)}`} />
          <Stat label="Sisa target" value={formatRupiah(progress.remainingAmount)} />
          <Stat label="Sisa waktu" testId="overview-target-days-left" value={`${formatNumber(progress.daysLeft)} hari`} />
        </dl>
      )}
    </>
  );
}

function TargetBody({
  progress,
  cumulative,
  today,
  canManageSettings,
}: {
  progress: GoalProgress;
  cumulative: readonly CumulativePoint[] | null;
  today: string;
  canManageSettings: boolean;
}) {
  if (progress.state === "not_configured") {
    return (
      <CardFrame>
        <p className="text-base text-neutral-700">Target penjualan belum diatur.</p>
        {canManageSettings && (
          <Link href="/settings" className="text-base font-medium text-brand underline">
            Atur target di Pengaturan
          </Link>
        )}
      </CardFrame>
    );
  }

  const period = `${formatCalendarDate(progress.startDate)} s.d. ${formatCalendarDate(progress.endDate)}`;

  if (progress.state === "not_started") {
    const daysUntil = calendarDaysBetween(today, progress.startDate);
    return (
      <CardFrame subtitle={period} badge={<Badge>Belum dimulai</Badge>}>
        <div className="flex flex-col gap-1">
          <p className="text-xl font-semibold text-neutral-900" data-testid="overview-target-start">
            Tahun pertama dimulai {formatCalendarDate(progress.startDate)}
          </p>
          <p className="text-base text-neutral-700">
            Target {formatRupiah(progress.targetAmount)}, mulai {formatNumber(daysUntil)} hari lagi.
          </p>
        </div>
      </CardFrame>
    );
  }

  const badge =
    progress.state === "ended" && progress.status !== "reached"
      ? { label: "Target tidak tercapai", variant: "danger" as const }
      : STATUS_BADGE[progress.status];
  const subtitle =
    progress.state === "ended"
      ? `${period}, sudah berakhir`
      : `${period}, hari ke-${formatNumber(progress.elapsedDays)} dari ${formatNumber(progress.totalDays)}`;

  return (
    <CardFrame subtitle={subtitle} badge={<Badge variant={badge.variant}>{badge.label}</Badge>}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
        <p className="font-serif text-4xl font-light text-neutral-900 tabular-nums" data-testid="overview-target-percent">
          {formatPercentBps(progress.progressBps)}
        </p>
        <p className="text-base text-neutral-700 tabular-nums" data-testid="overview-target-amounts">
          {formatRupiah(progress.actualAmount)} dari {formatRupiah(progress.targetAmount)}
        </p>
      </div>
      <GoalProgressBar progress={progress} />
      {progress.state === "active" && <PaceDetails progress={progress} />}
      {cumulative && <GoalCumulativeChart points={cumulative} today={today} />}
    </CardFrame>
  );
}

export function OverviewTargetCardSkeleton() {
  return <Skeleton className="h-56 rounded-lg" />;
}

/** Only for finance.view_profit (D9). The page does not mount it otherwise, and the session's own
 * permission goes to the queries too, which return null without it: neither the amounts nor the
 * percentage are ever computed for that viewer. The "Atur target" link needs settings.manage AND
 * finance.view_profit (the settings section's own gate). */
export async function OverviewTargetCard({
  now,
  today,
  canViewProfit,
  canManageSettings,
}: {
  now: Date;
  today: string;
  canViewProfit: boolean;
  canManageSettings: boolean;
}) {
  const [progress, cumulative] = await Promise.all([getGoalProgress({ canViewProfit, now }), getGoalCumulative({ canViewProfit, now })]);
  if (!progress) return null;
  return <TargetBody progress={progress} cumulative={cumulative} today={today} canManageSettings={canManageSettings} />;
}
