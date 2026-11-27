// Reconciliation poll windows for TikTok orders (docs/plans/tiktok-shop-integration.md §0 "Orders",
// §8.3; T4). Pure: callers pass the cursor and `now`.
//
// - Each run starts at the cursor's `window_end − 5 min` (overlap of at least 5 minutes, §0), so an
//   order TikTok indexed late near the previous end is still found.
// - Each run ends at `now − 2 min` (TikTok's search index lags the write).
// - The span is cut into contiguous slices of at most 6 hours, each with both `update_time` bounds.
// - The cursor moves to a slice's end only after that slice was fully fetched and stored (the sync
//   does that, slice by slice); a failure mid-slice leaves it, and the next run repeats the slice.
// - A first run (no cursor yet) starts at `backfill_from` when T9 set one, else 24 hours back.
// TikTok's bounds are whole seconds: a slice shorter than one second is never produced.

export const TIKTOK_POLL_OVERLAP_MS = 5 * 60_000;
export const TIKTOK_POLL_LAG_MS = 2 * 60_000;
export const TIKTOK_POLL_SLICE_MS = 6 * 60 * 60_000;
export const TIKTOK_POLL_INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;

export interface TikTokPollWindow {
  /** Inclusive (`update_time_ge`). */
  start: Date;
  /** Exclusive (`update_time_lt`). The cursor value once this slice is done. */
  end: Date;
}

export interface TikTokPollCursor {
  windowEnd: Date | null;
  backfillFrom: Date | null;
}

function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** The slices one run covers, oldest first. Empty when there is less than a second to cover. */
export function planTikTokPollWindows(cursor: TikTokPollCursor, now: Date): TikTokPollWindow[] {
  const end = floorToSecond(now.getTime() - TIKTOK_POLL_LAG_MS);
  const start = floorToSecond(
    cursor.windowEnd !== null ? cursor.windowEnd.getTime() - TIKTOK_POLL_OVERLAP_MS : (cursor.backfillFrom?.getTime() ?? now.getTime() - TIKTOK_POLL_INITIAL_LOOKBACK_MS),
  );
  const windows: TikTokPollWindow[] = [];
  for (let from = start; from < end; from += TIKTOK_POLL_SLICE_MS) {
    windows.push({ start: new Date(from), end: new Date(Math.min(from + TIKTOK_POLL_SLICE_MS, end)) });
  }
  return windows;
}
