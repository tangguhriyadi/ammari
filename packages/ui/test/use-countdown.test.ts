// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCountdown } from "../src/lib/use-countdown";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCountdown", () => {
  test("returns 0 when the target is null", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBe(0);
  });

  test("returns the remaining time at mount, without waiting for the first tick", () => {
    const now = Date.now();
    const { result } = renderHook(() => useCountdown(now + 5_000));
    expect(result.current).toBe(5_000);
  });

  test("ticks down roughly once a second", () => {
    const now = Date.now();
    const { result } = renderHook(() => useCountdown(now + 5_000));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(4_000);
  });

  test("reaching the target clamps to 0, never negative", () => {
    const now = Date.now();
    const { result } = renderHook(() => useCountdown(now + 2_000));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0);
  });

  // The actual bug this hook exists to avoid: counting ticks (e.g. `count - 1` per interval
  // firing) would be wrong here, because a backgrounded/suspended tab can skip many ticks and
  // then fire its `setInterval` callback only once upon resuming — a tick-counting
  // implementation would see "one tick elapsed" and be wrong by minutes. Recomputing from the
  // absolute `targetEpochMs` on that same single callback is what makes the jump correct
  // immediately, with no catch-up period.
  test("a large single jump (simulating a backgrounded tab resuming) is reflected immediately, not ticked through", () => {
    const now = Date.now();
    const { result } = renderHook(() => useCountdown(now + 5 * 60_000));
    expect(result.current).toBe(5 * 60_000);

    // One real-world resume firing (a single setInterval callback, or a visibilitychange/focus
    // event) after the tab was suspended for 4 real minutes — not 240 individual 1s ticks.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(result.current).toBe(60_000); // reflects the full 4-minute jump in one step
  });

  test("a visibilitychange event forces an immediate recompute, not just the next 1s tick", () => {
    const now = Date.now();
    const { result } = renderHook(() => useCountdown(now + 10_000));

    vi.setSystemTime(now + 7_000); // advance the clock without advancing timers
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(3_000);
  });
});
