// Hands an email to the login form without putting it in a URL (docs/plans/cart-checkout.md §4.4:
// the finish page's "Masuk untuk melihat semua pesanan" opens the email login with the order's
// contact email filled in). sessionStorage, so the address never lands in a query string, server
// logs, history or a Referer; this tab only, ignored after a few minutes, and cleared once the login
// code has been sent. Reading does not consume it, so a re-render or a dev StrictMode remount
// reads the same value. Client-safe
// (no directive), so server components can import the link target too.

/** The email login, landing on the account page until the order list exists (`/orders`, session 15). */
export const LOGIN_FOR_ORDERS_HREF = "/login?next=%2Faccount";

export const LOGIN_PREFILL_STORAGE_KEY = "ammari-web-login-prefill";
const MAX_AGE_MS = 10 * 60 * 1000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function storeLoginPrefill(email: string): void {
  try {
    window.sessionStorage.setItem(LOGIN_PREFILL_STORAGE_KEY, JSON.stringify({ email, at: Date.now() }));
  } catch {
    // Storage disabled: the buyer types the email, nothing else breaks.
  }
}

/** The handed-over email; null when absent, stale or not an email. Reading leaves it in place. */
export function readLoginPrefill(): string | null {
  try {
    const raw = window.sessionStorage.getItem(LOGIN_PREFILL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const email = (parsed as { email?: unknown } | null)?.email;
    const at = (parsed as { at?: unknown } | null)?.at;
    if (typeof email !== "string" || typeof at !== "number") return null;
    if (Date.now() - at > MAX_AGE_MS || email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
    return email;
  } catch {
    return null;
  }
}

export function clearLoginPrefill(): void {
  try {
    window.sessionStorage.removeItem(LOGIN_PREFILL_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is disabled.
  }
}
