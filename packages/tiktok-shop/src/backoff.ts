import "server-only";

// Retry timing for the API client (docs/plans/tiktok-shop-integration.md §0 "Rate limits", §8.2).
// Pure functions: the client injects the clock, the sleep and the random source, so tests can run
// the whole schedule with a fake clock and seeded jitter.

/** HTTP 429 or this envelope code is a rate limit. */
export const RATE_LIMIT_CODE = 36009002;

/** At most 5 tries in total for a rate-limited request (4 waits), then `rate_limited`. */
export const MAX_RATE_LIMIT_TRIES = 5;
export const RATE_LIMIT_MIN_DELAY_MS = 1_000;
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** 503 and other 5xx (not a rate limit), and network errors: 2 short retries, then give up. */
export const SHORT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Exponential with full jitter, bounded to 1-60 s. `retry` is 1 for the first wait. The cap grows
 * 1 s, 4 s, 16 s, 60 s (64 s clamped); the delay is uniform in [1 s, cap]. `random` is in [0, 1). */
export function rateLimitDelayMs(retry: number, random: () => number): number {
  if (!Number.isInteger(retry) || retry < 1) throw new Error("rateLimitDelayMs: retry starts at 1");
  const cap = Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_MIN_DELAY_MS * 4 ** (retry - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(RATE_LIMIT_MIN_DELAY_MS + r * (cap - RATE_LIMIT_MIN_DELAY_MS));
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP-date (RFC 9110 §10.2.3). Null when
 * absent or unparseable, so the caller falls back to the jittered schedule. A date in the past is
 * 0. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (/^[0-9]{1,9}$/.test(value)) return Number(value) * 1_000;
  // An HTTP-date always names a weekday; requiring a letter keeps "-5" or "1.5" from parsing as a
  // date in some runtimes.
  if (!/^[A-Za-z]/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
