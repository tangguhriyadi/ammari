/** Milliseconds remaining until `targetEpochMs`, clamped to 0 — never negative. Always derived
 * from absolute timestamps rather than decremented, so a caller recomputing this on each render
 * stays correct across a tab refresh or an iOS screen lock/resume (where a `setInterval` tick
 * counter would otherwise be stale by however long the tab was suspended) — see
 * `use-countdown.ts`'s own doc comment for the hook that actually drives re-renders from this. */
export function remainingMs(targetEpochMs: number, nowEpochMs: number = Date.now()): number {
  return Math.max(0, targetEpochMs - nowEpochMs);
}

/** "m:ss", e.g. 65_000 -> "1:05", 0 -> "0:00". `Math.ceil` (not floor/round) on the seconds so
 * the display only ticks down to the NEXT whole second once that much time has fully elapsed
 * (300_000ms shows "5:00" all the way down to 299_001ms, not "4:59" a fraction of a second into
 * the countdown) — the usual "time remaining" convention. Never negative (clamp via
 * `remainingMs` first) and never rolls into hours — OTP/resend countdowns here never exceed a
 * few minutes. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
