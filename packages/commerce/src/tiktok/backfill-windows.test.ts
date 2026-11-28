import { describe, expect, test } from "vitest";
import { TIKTOK_BACKFILL_FLOOR } from "@ammari/db/schema";
import { nextTikTokBackfillSliceSeconds, planTikTokBackfillWindows, tiktokBackfillRange } from "./backfill-windows";

// docs/plans/tiktok-shop-integration.md T9: the backfill's own slices over [from, until), resumable at
// the last finished slice, and order slices that halve when one does not fit a run (T4 known limit).

const HOUR = 3_600_000;
const FROM = new Date("2026-12-01T00:00:00+07:00");

describe("planTikTokBackfillWindows", () => {
  test("contiguous slices from `from` to `until`, both bounds set, the last one cut at `until`", () => {
    const until = new Date(FROM.getTime() + 13 * HOUR);
    const windows = planTikTokBackfillWindows({ from: FROM, until, doneUntil: null, sliceSeconds: 6 * 3600 });
    expect(windows.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ["2026-11-30T17:00:00.000Z", "2026-11-30T23:00:00.000Z"],
      ["2026-11-30T23:00:00.000Z", "2026-12-01T05:00:00.000Z"],
      ["2026-12-01T05:00:00.000Z", "2026-12-01T06:00:00.000Z"],
    ]);
  });

  test("resumes at doneUntil (no overlap needed: history does not move under the window)", () => {
    const until = new Date(FROM.getTime() + 4 * HOUR);
    const windows = planTikTokBackfillWindows({ from: FROM, until, doneUntil: new Date(FROM.getTime() + 3 * HOUR), sliceSeconds: 3600 });
    expect(windows).toEqual([{ start: new Date(FROM.getTime() + 3 * HOUR), end: until }]);
  });

  test("done: nothing left", () => {
    const until = new Date(FROM.getTime() + HOUR);
    expect(planTikTokBackfillWindows({ from: FROM, until, doneUntil: until, sliceSeconds: 60 })).toEqual([]);
  });

  test("whole seconds only", () => {
    const until = new Date(FROM.getTime() + 1500);
    const windows = planTikTokBackfillWindows({ from: new Date(FROM.getTime() + 250), until, doneUntil: null, sliceSeconds: 60 });
    expect(windows).toEqual([{ start: FROM, end: new Date(FROM.getTime() + 1000) }]);
  });
});

describe("nextTikTokBackfillSliceSeconds", () => {
  test("halves when a slice did not finish in its run, never below one minute", () => {
    expect(nextTikTokBackfillSliceSeconds(21600, { finished: false, elapsedMs: 0, budgetMs: 100_000 })).toBe(10800);
    expect(nextTikTokBackfillSliceSeconds(90, { finished: false, elapsedMs: 0, budgetMs: 100_000 })).toBe(60);
    expect(nextTikTokBackfillSliceSeconds(60, { finished: false, elapsedMs: 0, budgetMs: 100_000 })).toBe(60);
  });

  test("doubles back (≤ 6 h) only after a slice finished within a quarter of the budget, so it never oscillates", () => {
    expect(nextTikTokBackfillSliceSeconds(3600, { finished: true, elapsedMs: 20_000, budgetMs: 100_000 })).toBe(7200);
    expect(nextTikTokBackfillSliceSeconds(3600, { finished: true, elapsedMs: 30_000, budgetMs: 100_000 })).toBe(3600);
    expect(nextTikTokBackfillSliceSeconds(21600, { finished: true, elapsedMs: 0, budgetMs: 100_000 })).toBe(21600);
  });
});

describe("tiktokBackfillRange", () => {
  const now = new Date("2026-12-20T05:00:00.000Z");
  test("from = Jakarta midnight of the date, until = now − 2 min, whole seconds", () => {
    expect(tiktokBackfillRange("2026-12-01", now)).toEqual({ ok: true, from: TIKTOK_BACKFILL_FLOOR, until: new Date(now.getTime() - 120_000) });
  });

  test("never before the books start, never a malformed or future date", () => {
    expect(tiktokBackfillRange("2026-11-30", now)).toEqual({ ok: false, reason: "before_floor" });
    expect(tiktokBackfillRange("2026-12-20", now)).toEqual({ ok: false, reason: "not_in_past" });
    expect(tiktokBackfillRange("2026-13-01", now)).toEqual({ ok: false, reason: "invalid_date" });
    expect(tiktokBackfillRange("1 Des", now)).toEqual({ ok: false, reason: "invalid_date" });
  });
});
