import { describe, expect, test } from "vitest";
import { formatCountdown, remainingMs } from "../src/lib/countdown";

describe("remainingMs", () => {
  test("returns the difference when the target is in the future", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
  });

  test("clamps to 0 once the target has passed", () => {
    expect(remainingMs(10_000, 10_000)).toBe(0);
    expect(remainingMs(10_000, 15_000)).toBe(0);
  });

  test("defaults `nowEpochMs` to Date.now() when omitted", () => {
    const target = Date.now() + 5_000;
    const result = remainingMs(target);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(5_000);
  });
});

describe("formatCountdown", () => {
  test("formats whole minutes and seconds as m:ss", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
  });

  test("pads single-digit seconds", () => {
    expect(formatCountdown(5_000)).toBe("0:05");
  });

  test("formats exactly 5 minutes", () => {
    expect(formatCountdown(5 * 60 * 1000)).toBe("5:00");
  });

  test("zero remaining shows 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
  });

  test("a sub-second remainder still shows the full second (ceil, not floor)", () => {
    expect(formatCountdown(59_900)).toBe("1:00"); // not "0:59" — a whole second hasn't elapsed yet
    expect(formatCountdown(59_000)).toBe("0:59");
  });

  test("never goes negative even if given a negative input", () => {
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});
