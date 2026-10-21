// Right after a deploy, a page rendered by the previous build still calls the previous build's
// server actions and asks for its JavaScript chunks; the new server knows neither (2026-10-21: the
// /account contact offer's "Simpan" showed a blank page). Every storefront call site and error
// boundary treats that as "the page is out of date": the buyer sees STALE_PAGE_MESSAGE and the page
// reloads itself once, so the next tap runs against the new build. Nothing was done on the server:
// an action the server does not know never runs, so retrying after the reload is safe.

export const STALE_PAGE_MESSAGE = "Halaman sudah diperbarui. Coba lagi.";
/** When the page will not reload itself (it just did, or storage is blocked): ask for it by hand. */
export const STALE_PAGE_RELOAD_MESSAGE = "Halaman sudah diperbarui. Muat ulang halaman ini, lalu coba lagi.";

/** How soon after the page reloaded itself it will not do so again (a loop guard: a page that is
 * still stale after a reload shows the message with a button instead). */
const AUTO_RELOAD_GUARD_MS = 30_000;
const AUTO_RELOAD_KEY = "ammari_stale_reload_at";
/** Long enough to read the message before the page goes. */
export const STALE_RELOAD_DELAY_MS = 1_500;

/** A server action the server does not recognize (Next's UnrecognizedActionError, which sets its
 * own `name`, so it survives minification; Next 16.3's `unstable_isUnrecognizedActionError` checks
 * the same class but is unstable API), or a JavaScript chunk of the previous build that is gone. */
export function isStaleDeploymentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "UnrecognizedActionError" || error.name === "ChunkLoadError") return true;
  return /Server Action .* was not found on the server|Failed to find Server Action|Loading chunk [^ ]+ failed|Failed to load chunk/i.test(error.message);
}

/** Reloads the page once, after STALE_RELOAD_DELAY_MS. Returns false (and does nothing) when the
 * page already reloaded itself moments ago, so a page that stays stale never loops. */
export function scheduleStaleReload(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(AUTO_RELOAD_KEY) ?? 0);
  } catch {
    // Blocked storage: no loop guard to read, so reload only by hand.
    return false;
  }
  if (Date.now() - last < AUTO_RELOAD_GUARD_MS) return false;
  try {
    sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.setTimeout(() => window.location.reload(), STALE_RELOAD_DELAY_MS);
  return true;
}

/** For a call site's own catch: the message to show for a call that failed. A stale page gets
 * STALE_PAGE_MESSAGE and reloads itself (or, when it will not, asks for a reload by hand); anything
 * else gets `fallback`. */
export function failedCallMessage(error: unknown, fallback: string): string {
  if (!isStaleDeploymentError(error)) return fallback;
  console.info("[deploy] this page is from an earlier build; reloading it");
  return scheduleStaleReload() ? STALE_PAGE_MESSAGE : STALE_PAGE_RELOAD_MESSAGE;
}
