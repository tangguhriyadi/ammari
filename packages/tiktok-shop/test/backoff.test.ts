import { describe, expect, test } from "vitest";
import { seeded } from "./random";
import { RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_MIN_DELAY_MS, parseRetryAfterMs, rateLimitDelayMs } from "../src/backoff";

describe("rateLimitDelayMs (exponential, full jitter, 1-60 s)", () => {
  test("caps grow 1 s, 4 s, 16 s, 60 s and stay at 60 s", () => {
    const max = () => 0.999999999;
    expect([1, 2, 3, 4, 5, 10].map((retry) => rateLimitDelayMs(retry, max))).toEqual([1_000, 4_000, 16_000, 60_000, 60_000, 60_000]);
  });

  test("the lowest jitter is 1 s, never 0", () => {
    for (const retry of [1, 2, 3, 4, 8]) expect(rateLimitDelayMs(retry, () => 0)).toBe(1_000);
  });

  test("seeded jitter always stays within [1 s, cap] and [1 s, 60 s]", () => {
    const random = seeded(42);
    for (let i = 0; i < 2_000; i += 1) {
      const retry = (i % 6) + 1;
      const delay = rateLimitDelayMs(retry, random);
      expect(delay).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(Math.min(RATE_LIMIT_MAX_DELAY_MS, 1_000 * 4 ** (retry - 1)));
    }
  });

  test("the same seed gives the same schedule", () => {
    const a = seeded(7);
    const b = seeded(7);
    expect([1, 2, 3, 4].map((r) => rateLimitDelayMs(r, a))).toEqual([1, 2, 3, 4].map((r) => rateLimitDelayMs(r, b)));
  });

  test("an out-of-range random source is clamped", () => {
    expect(rateLimitDelayMs(4, () => 5)).toBe(60_000);
    expect(rateLimitDelayMs(4, () => -1)).toBe(1_000);
  });

  test("retry numbers start at 1", () => {
    expect(() => rateLimitDelayMs(0, () => 0)).toThrow();
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.UTC(2026, 10, 27, 3, 0, 0);

  test("delta-seconds", () => {
    expect(parseRetryAfterMs("7", now)).toBe(7_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
  });

  test("HTTP-date", () => {
    expect(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now)).toBe(12_000);
    expect(parseRetryAfterMs(new Date(now - 12_000).toUTCString(), now)).toBe(0);
  });

  test("absent or unparseable → null (fall back to jitter)", () => {
    for (const value of [null, undefined, "", "soon", "-5", "1.5", "1e3"]) expect(parseRetryAfterMs(value, now)).toBeNull();
  });
});
