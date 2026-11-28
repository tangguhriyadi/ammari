// The after() push's single flight (docs/plans/tiktok-stock-sync.md §7, S2). Every stock change asks for
// a push right after its response; within one app process at most one push runs at a time, and a request
// that arrives while one runs makes it run once more when it ends (so a change committed mid-push is
// still pushed at once, with a fresh compute). This keeps the after() pushes to one database connection
// per process however many checkouts land together; across processes (admin, web slots, the cron) the
// per-product advisory lock serialises them. Pure: no database, no TikTok, no Next.js.

export type TikTokStockPushRequest = () => Promise<void>;

/** `run` must not throw (it logs its own failures); if it does, the flight ends and the error is dropped
 * here, so a broken push never fails the caller's response. */
export function createTikTokStockPushScheduler(run: () => Promise<void>): TikTokStockPushRequest {
  let flight: Promise<void> | null = null;
  let again = false;
  return function request(): Promise<void> {
    if (flight) {
      again = true;
      return flight;
    }
    flight = (async () => {
      try {
        do {
          again = false;
          await run().catch(() => undefined);
        } while (again);
      } finally {
        flight = null;
      }
    })();
    return flight;
  };
}
