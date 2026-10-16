"use client";

import { useEffect, useState } from "react";
import { remainingMs } from "./countdown";

/** Milliseconds remaining until `targetEpochMs` (or 0 if `targetEpochMs` is `null`), re-read once
 * a second so a consumer re-renders — but the VALUE itself always comes from
 * `remainingMs(targetEpochMs, now)`, an absolute-timestamp computation, never a decremented
 * counter. That distinction is what keeps this correct across an iOS screen lock: `setInterval`
 * itself gets throttled/suspended while the tab is backgrounded, so the first tick after
 * resuming could otherwise be "late" by however long the tab was suspended — recomputing from
 * timestamps means whenever that tick (or a `visibilitychange`/`focus` event, forced below) does
 * fire, it's immediately correct regardless of how many ticks were missed. Callers are
 * responsible for persisting `targetEpochMs` itself somewhere that survives a refresh (e.g.
 * `sessionStorage`) — this hook only handles re-deriving the remaining time from it. */
export function useCountdown(targetEpochMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (targetEpochMs === null) return;
    const tick = () => setNow(Date.now());
    tick(); // don't wait a full second to reflect a freshly-set target
    const interval = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [targetEpochMs]);

  if (targetEpochMs === null) return 0;
  return remainingMs(targetEpochMs, now);
}
