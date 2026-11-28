import "server-only";
import { after } from "next/server";
import { errorLogFields } from "@ammari/commerce/errors";
import { createTikTokStockPushScheduler, pushTikTokStockNow, tiktokRuntimeFromEnv } from "@ammari/commerce/tiktok";
import { defaultDb } from "@/lib/db";

// The best-effort TikTok stock push right after a stock change commits (docs/plans/tiktok-stock-sync.md
// §7, S2). Never inside the stock transaction and never blocking or failing the response: it runs in
// after(), at most one at a time in this process (createTikTokStockPushScheduler), and only does work
// when the stock switch is on and something is due (one cheap query otherwise). Whatever it misses, or
// fails to push, the cron's drain (/api/internal/tiktok/sync, every 5 minutes) retries with backoff.
// Logs counts, ids and codes only: never a token, a URL or a body.

const requestPush = createTikTokStockPushScheduler(async () => {
  try {
    const runtime = tiktokRuntimeFromEnv(process.env);
    if (!runtime.ok) return;
    const { api, auth, config } = runtime.runtime;
    const counts = await pushTikTokStockNow(defaultDb, { api, auth, keyring: config.tokenKeyring });
    if (!counts) return;
    if (counts.failed + counts.errors + counts.refused + counts.busy > 0) console.warn("[tiktok] stock push after a change needs a look; the cron retries", counts);
    else if (counts.calls > 0) console.info("[tiktok] stock pushed after a change", { calls: counts.calls, pushed: counts.pushed, unchanged: counts.unchanged, held: counts.held });
  } catch (error) {
    console.error("[tiktok] stock push after a change failed; the cron retries", errorLogFields(error));
  }
});

/** Call after a write that may have changed a variant's TikTok quantity has COMMITTED (a stock movement,
 * a checkout hold, a SKU mapping, the stock switch). Safe to call from anywhere: outside a request (a
 * script, a test) it starts the push without waiting for it. */
export function pushTikTokStockAfterResponse(): void {
  try {
    after(() => requestPush());
  } catch {
    void requestPush();
  }
}
