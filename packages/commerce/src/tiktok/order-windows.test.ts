import { describe, expect, test } from "vitest";
import { TIKTOK_POLL_INITIAL_LOOKBACK_MS, TIKTOK_POLL_LAG_MS, TIKTOK_POLL_OVERLAP_MS, TIKTOK_POLL_SLICE_MS, planTikTokPollWindows } from "./order-windows";

// docs/plans/tiktok-shop-integration.md §8.3, T4: overlap of at least 5 minutes, both bounds, ≤ 6-h
// slices, a 2-minute lag, whole seconds.

const NOW = new Date("2026-11-27T03:00:00.000Z");
const MIN = 60_000;

describe("planTikTokPollWindows", () => {
  test("starts 5 minutes before the cursor and ends 2 minutes before now", () => {
    const windowEnd = new Date(NOW.getTime() - 7 * MIN);
    const windows = planTikTokPollWindows({ windowEnd, backfillFrom: null }, NOW);
    expect(windows).toEqual([{ start: new Date(windowEnd.getTime() - TIKTOK_POLL_OVERLAP_MS), end: new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS) }]);
    expect(windowEnd.getTime() - windows[0]!.start.getTime()).toBeGreaterThanOrEqual(5 * MIN);
  });

  test("the next run overlaps the previous run's end by at least 5 minutes", () => {
    const first = planTikTokPollWindows({ windowEnd: new Date(NOW.getTime() - 30 * MIN), backfillFrom: null }, NOW);
    const cursor = first.at(-1)!.end;
    const later = new Date(NOW.getTime() + 5 * MIN);
    const second = planTikTokPollWindows({ windowEnd: cursor, backfillFrom: null }, later);
    expect(cursor.getTime() - second[0]!.start.getTime()).toBe(TIKTOK_POLL_OVERLAP_MS);
    expect(second.at(-1)!.end.getTime()).toBe(later.getTime() - TIKTOK_POLL_LAG_MS);
  });

  test("a long gap is cut into contiguous slices of at most 6 hours, each with both bounds", () => {
    const windowEnd = new Date(NOW.getTime() - 20 * 60 * MIN);
    const windows = planTikTokPollWindows({ windowEnd, backfillFrom: null }, NOW);
    expect(windows.length).toBe(4);
    for (const [index, window] of windows.entries()) {
      expect(window.start.getTime()).toBeLessThan(window.end.getTime());
      expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(TIKTOK_POLL_SLICE_MS);
      if (index > 0) expect(window.start.getTime()).toBe(windows[index - 1]!.end.getTime());
      expect(window.start.getTime() % 1000).toBe(0);
      expect(window.end.getTime() % 1000).toBe(0);
    }
  });

  test("a first run starts at backfill_from, else 24 hours back", () => {
    const backfillFrom = new Date("2026-11-26T00:00:00.000Z");
    expect(planTikTokPollWindows({ windowEnd: null, backfillFrom }, NOW)[0]!.start).toEqual(backfillFrom);
    expect(planTikTokPollWindows({ windowEnd: null, backfillFrom: null }, NOW)[0]!.start).toEqual(new Date(NOW.getTime() - TIKTOK_POLL_INITIAL_LOOKBACK_MS));
  });

  test("nothing to do when the cursor is at or beyond now − lag + overlap (clock skew), or less than a second remains", () => {
    expect(planTikTokPollWindows({ windowEnd: new Date(NOW.getTime() + 10 * MIN), backfillFrom: null }, NOW)).toEqual([]);
    expect(planTikTokPollWindows({ windowEnd: new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS + TIKTOK_POLL_OVERLAP_MS + 500), backfillFrom: null }, NOW)).toEqual([]);
  });
});
