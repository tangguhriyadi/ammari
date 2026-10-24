import { addCalendarDays, addCalendarYears, calendarDaysBetween } from "@ammari/commerce/jakarta-day";

// The first-year target tracker's arithmetic (docs/plans/dashboard-overview.md §2.3). Pure and in
// whole rupiah / whole days; percentages in integer basis points. Straight-line pace for now (D4).

export interface SalesGoal {
  revenueTargetAmount: number;
  /** Jakarta calendar date; null = not configured. */
  startDate: string | null;
}

export interface GoalWindow {
  startDate: string;
  /** Inclusive: start + 1 year - 1 day. */
  endDate: string;
  totalDays: number;
}

/** Below this many pieces sold in the recent window there is no average price worth converting
 * the needed pace into pieces with. */
export const MIN_PCS_FOR_AVERAGE_PRICE = 10;

/** "Perlu Rp X per bulan" is the daily pace times this, a round reading, not a calendar month. */
const DAYS_PER_MONTH = 30;

export type GoalStatus = "reached" | "on_track" | "behind";

export interface GoalPace {
  targetAmount: number;
  startDate: string;
  endDate: string;
  actualAmount: number;
  /** actual / target, can pass 10000. */
  progressBps: number;
  totalDays: number;
  /** Today counts as elapsed. */
  elapsedDays: number;
  /** Including today; 0 once the year has ended. */
  daysLeft: number;
  /** Where a straight line from 0 to the target stands today. */
  expectedAmount: number;
  status: GoalStatus;
  /** expected - actual when behind, else 0. */
  gapAmount: number;
  remainingAmount: number;
  /** Null once reached or ended. */
  neededPerDay: number | null;
  neededPerMonth: number | null;
  neededPcsPerDay: number | null;
}

export type GoalProgress =
  | { state: "not_configured" }
  | { state: "not_started"; targetAmount: number; startDate: string; endDate: string }
  | ({ state: "active" | "ended" } & GoalPace);

export function goalWindow(goal: SalesGoal): GoalWindow | null {
  if (!goal.startDate) return null;
  const endDate = addCalendarDays(addCalendarYears(goal.startDate, 1), -1);
  return { startDate: goal.startDate, endDate, totalDays: calendarDaysBetween(goal.startDate, endDate) + 1 };
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("goal progress overflow");
  return value;
}

/**
 * @param today Jakarta calendar date.
 * @param actualAmount Omzet from the start of the goal year up to now.
 * @param recent Omzet and pieces of a recent window (the caller's: the last 30 days), for the
 *   average price per piece.
 */
export function computeGoalProgress(
  goal: SalesGoal,
  today: string,
  actualAmount: number,
  recent: { omzet: number; pcs: number },
): GoalProgress {
  const window = goalWindow(goal);
  if (!window) return { state: "not_configured" };
  const { startDate, endDate, totalDays } = window;
  const targetAmount = goal.revenueTargetAmount;
  if (calendarDaysBetween(startDate, today) < 0) return { state: "not_started", targetAmount, startDate, endDate };

  const elapsedDays = Math.min(calendarDaysBetween(startDate, today) + 1, totalDays);
  const ended = calendarDaysBetween(endDate, today) > 0;
  const daysLeft = ended ? 0 : calendarDaysBetween(today, endDate) + 1;
  const expectedAmount = safe(Math.floor((targetAmount * elapsedDays) / totalDays));
  const status: GoalStatus = actualAmount >= targetAmount ? "reached" : actualAmount >= expectedAmount ? "on_track" : "behind";
  const remainingAmount = Math.max(targetAmount - actualAmount, 0);

  const needsPace = !ended && status !== "reached";
  const neededPerDay = needsPace ? Math.ceil(remainingAmount / daysLeft) : null;
  const averagePrice = recent.pcs >= MIN_PCS_FOR_AVERAGE_PRICE ? Math.floor(recent.omzet / recent.pcs) : 0;

  return {
    state: ended ? "ended" : "active",
    targetAmount,
    startDate,
    endDate,
    actualAmount,
    progressBps: safe(Math.floor((actualAmount * 10_000) / targetAmount)),
    totalDays,
    elapsedDays,
    daysLeft,
    expectedAmount,
    status,
    gapAmount: status === "behind" ? expectedAmount - actualAmount : 0,
    remainingAmount,
    neededPerDay,
    neededPerMonth: neededPerDay === null ? null : neededPerDay * DAYS_PER_MONTH,
    neededPcsPerDay: neededPerDay !== null && averagePrice > 0 ? Math.ceil(neededPerDay / averagePrice) : null,
  };
}
