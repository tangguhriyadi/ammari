import { TIKTOK_POLL_LAG_MS, TIKTOK_POLL_OVERLAP_MS, type TikTokPollCursor, type TikTokPollWindow } from "./order-windows";

// Poll windows for TikTok statements (`statement_time`) and payouts (`create_time`)
// (docs/plans/tiktok-shop-integration.md §8.3, T7). Pure. The same overlap and lag as the order poll
// (order-windows.ts); statements come once a day, so slices are up to 31 days and a first run looks
// back 35 days. A statement keeps changing after its time (PROCESSING → PAID with its payout), so each
// run also reopens back to the oldest stored record that may still change (not paid, held, or its
// transactions not complete), but never more than 90 days back, and always covers the last 7 days.

const DAY_MS = 86_400_000;
export const TIKTOK_FINANCE_SLICE_MS = 31 * DAY_MS;
export const TIKTOK_FINANCE_INITIAL_LOOKBACK_MS = 35 * DAY_MS;
export const TIKTOK_FINANCE_REOPEN_MAX_MS = 90 * DAY_MS;
/** Every run covers at least the last 7 days: a statement or payout can be published after its own
 * time (a day's statement is generated later), which the 5-minute overlap alone would miss. They are
 * few (one statement a day), so this costs one call per run. */
export const TIKTOK_FINANCE_MIN_LOOKBACK_MS = 7 * DAY_MS;

function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

export function planTikTokFinanceWindows(cursor: TikTokPollCursor, now: Date, reopenFrom: Date | null): TikTokPollWindow[] {
  const end = floorToSecond(now.getTime() - TIKTOK_POLL_LAG_MS);
  let start = cursor.windowEnd !== null ? cursor.windowEnd.getTime() - TIKTOK_POLL_OVERLAP_MS : (cursor.backfillFrom?.getTime() ?? now.getTime() - TIKTOK_FINANCE_INITIAL_LOOKBACK_MS);
  start = Math.min(start, now.getTime() - TIKTOK_FINANCE_MIN_LOOKBACK_MS);
  if (reopenFrom !== null) start = Math.min(start, Math.max(reopenFrom.getTime(), now.getTime() - TIKTOK_FINANCE_REOPEN_MAX_MS));
  start = floorToSecond(start);
  const windows: TikTokPollWindow[] = [];
  for (let from = start; from < end; from += TIKTOK_FINANCE_SLICE_MS) {
    windows.push({ start: new Date(from), end: new Date(Math.min(from + TIKTOK_FINANCE_SLICE_MS, end)) });
  }
  return windows;
}
