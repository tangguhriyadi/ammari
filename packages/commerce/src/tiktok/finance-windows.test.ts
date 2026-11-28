import { describe, expect, test } from "vitest";
import { TIKTOK_FINANCE_INITIAL_LOOKBACK_MS, TIKTOK_FINANCE_MIN_LOOKBACK_MS, TIKTOK_FINANCE_REOPEN_MAX_MS, TIKTOK_FINANCE_SLICE_MS, planTikTokFinanceWindows } from "./finance-windows";
import { TIKTOK_POLL_LAG_MS, TIKTOK_POLL_OVERLAP_MS } from "./order-windows";

// docs/plans/tiktok-shop-integration.md §8.3, T7: statements and payouts are polled by their own time
// (statement_time, create_time) with the order poll's overlap and lag, in slices of at most 31 days,
// and reopened back to the oldest record still changing (not paid yet, or held), at most 90 days.

const NOW = new Date("2026-12-05T03:00:00.000Z");
const DAY = 86_400_000;

describe("planTikTokFinanceWindows", () => {
  test("first run: from backfill_from, else the initial lookback; ends at now − lag", () => {
    const windows = planTikTokFinanceWindows({ windowEnd: null, backfillFrom: null }, NOW, null);
    expect(windows[0]!.start.getTime()).toBe(NOW.getTime() - TIKTOK_FINANCE_INITIAL_LOOKBACK_MS);
    expect(windows.at(-1)!.end.getTime()).toBe(NOW.getTime() - TIKTOK_POLL_LAG_MS);
    const backfill = new Date("2026-11-20T00:00:00.000Z");
    expect(planTikTokFinanceWindows({ windowEnd: null, backfillFrom: backfill }, NOW, null)[0]!.start).toEqual(backfill);
  });

  test("later runs start at the cursor − overlap, contiguous slices of at most 31 days", () => {
    const windows = planTikTokFinanceWindows({ windowEnd: new Date(NOW.getTime() - 70 * DAY), backfillFrom: null }, NOW, null);
    expect(windows[0]!.start.getTime()).toBe(NOW.getTime() - 70 * DAY - TIKTOK_POLL_OVERLAP_MS);
    for (const [index, window] of windows.entries()) {
      expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(TIKTOK_FINANCE_SLICE_MS);
      if (index > 0) expect(window.start).toEqual(windows[index - 1]!.end);
    }
    expect(windows).toHaveLength(3);
  });

  test("reopened back to the oldest record still changing, never further than 90 days", () => {
    const cursor = { windowEnd: new Date(NOW.getTime() - DAY), backfillFrom: null };
    const reopen = new Date(NOW.getTime() - 10 * DAY);
    expect(planTikTokFinanceWindows(cursor, NOW, reopen)[0]!.start).toEqual(reopen);
    const ancient = new Date(NOW.getTime() - 400 * DAY);
    expect(planTikTokFinanceWindows(cursor, NOW, ancient)[0]!.start.getTime()).toBe(NOW.getTime() - TIKTOK_FINANCE_REOPEN_MAX_MS);
    // A reopen point inside the last 7 days changes nothing.
    expect(planTikTokFinanceWindows(cursor, NOW, new Date(NOW.getTime() - 60_000))[0]!.start.getTime()).toBe(NOW.getTime() - TIKTOK_FINANCE_MIN_LOOKBACK_MS);
  });

  test("a cursor that is up to date still covers the last 7 days (a statement published after its time)", () => {
    const windows = planTikTokFinanceWindows({ windowEnd: new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS), backfillFrom: null }, NOW, null);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.start.getTime()).toBe(NOW.getTime() - TIKTOK_FINANCE_MIN_LOOKBACK_MS);
  });

  test("whole seconds", () => {
    for (const window of planTikTokFinanceWindows({ windowEnd: new Date(NOW.getTime() - DAY + 123), backfillFrom: null }, NOW, null)) expect(window.start.getTime() % 1000).toBe(0);
  });
});
