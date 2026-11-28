import { TIKTOK_BACKFILL_FLOOR, TIKTOK_BACKFILL_MAX_SLICE_SECONDS, TIKTOK_BACKFILL_MIN_SLICE_SECONDS } from "@ammari/db/schema";
import { TIKTOK_POLL_LAG_MS, type TikTokPollWindow } from "./order-windows";

// The backfill's windows (docs/plans/tiktok-shop-integration.md T9). Pure: callers pass the range,
// the progress and `now`.
//
// - A backfill covers [from, until): from = Jakarta midnight of the chosen day (never before the books
//   start, TIKTOK_BACKFILL_FLOOR), until = the moment it was requested − 2 min (TikTok's index lag).
//   Everything after `until` is the live poll's.
// - It resumes at the last finished slice (`doneUntil`). No overlap is needed: the live poll covers
//   anything that changes after `until`, and a history slice is repeated whole when it did not finish.
// - Order slices start at 6 h and halve, down to one minute, when one does not finish within a run
//   (T4's known limit: a 6-h slice too big for one run would never finish). They grow back only after
//   a slice finished within a quarter of its budget, so the size never oscillates.

const DAY_MS = 86_400_000;

function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

export function planTikTokBackfillWindows(input: { from: Date; until: Date; doneUntil: Date | null; sliceSeconds: number }): TikTokPollWindow[] {
  const end = floorToSecond(input.until.getTime());
  const sliceMs = input.sliceSeconds * 1000;
  const windows: TikTokPollWindow[] = [];
  for (let from = floorToSecond((input.doneUntil ?? input.from).getTime()); from < end; from += sliceMs) {
    windows.push({ start: new Date(from), end: new Date(Math.min(from + sliceMs, end)) });
  }
  return windows;
}

export function nextTikTokBackfillSliceSeconds(current: number, outcome: { finished: boolean; elapsedMs: number; budgetMs: number }): number {
  if (!outcome.finished) return Math.max(TIKTOK_BACKFILL_MIN_SLICE_SECONDS, Math.floor(current / 2));
  if (outcome.elapsedMs * 4 <= outcome.budgetMs) return Math.min(TIKTOK_BACKFILL_MAX_SLICE_SECONDS, current * 2);
  return current;
}

export type TikTokBackfillRange = { ok: true; from: Date; until: Date } | { ok: false; reason: "invalid_date" | "before_floor" | "not_in_past" };

/** The range a backfill started now from `fromDate` ("YYYY-MM-DD", a Jakarta calendar day) covers. */
export function tiktokBackfillRange(fromDate: string, now: Date): TikTokBackfillRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return { ok: false, reason: "invalid_date" };
  const from = new Date(`${fromDate}T00:00:00+07:00`);
  // A date like 2026-02-30 rolls over in Date; the round trip catches it.
  if (Number.isNaN(from.getTime()) || new Date(from.getTime() + 7 * 3600_000).toISOString().slice(0, 10) !== fromDate) return { ok: false, reason: "invalid_date" };
  if (from.getTime() < TIKTOK_BACKFILL_FLOOR.getTime()) return { ok: false, reason: "before_floor" };
  const until = new Date(floorToSecond(now.getTime() - TIKTOK_POLL_LAG_MS));
  // At least one whole day behind: today belongs to the live poll.
  if (until.getTime() - from.getTime() < DAY_MS) return { ok: false, reason: "not_in_past" };
  return { ok: true, from, until };
}
