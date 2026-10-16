/** Remembers the last time THIS browser actually triggered an OTP send for a given email,
 * independent of the per-flow OTP session state (sessionStorage, cleared on login success or on
 * "Ganti email") — fixes a real bug: re-requesting a code within the server's 60s per-email
 * cooldown (e.g. logout, then immediately log back in with the same email) silently no-ops
 * server-side (better-auth's `emailOTP` plugin's send endpoint always returns `{success: true}`
 * regardless of whether `sendVerificationOTP` actually sent anything — see
 * packages/auth/src/customer/create-customer-auth.ts's own doc comment), while the login form
 * had no memory of the earlier send once its session-scoped state was gone, so it restarted both
 * the 5-minute expiry and 60-second resend countdowns from zero as if a fresh code had gone out.
 *
 * Keyed by a SHA-256 hash of the lowercased/trimmed email (Web Crypto, never the raw address) in
 * `localStorage` — NOT `sessionStorage`, specifically because this must survive the very
 * logout/login cycle that clears the per-flow session key. Only a timestamp is ever stored: no
 * email, no OTP, no session data — so even reading the raw localStorage value back out reveals
 * nothing about who it's for.
 *
 * Each of apps/web and apps/admin passes its OWN `storageKeyPrefix` (same "two separate storage
 * namespaces" convention their login forms already use for the session key), so this one shared
 * module never mixes staff and customer state. */

const HEX_CHARS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

async function hashEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => HEX_CHARS[byte]).join("");
}

function storageKeyFor(storageKeyPrefix: string, emailHash: string): string {
  return `${storageKeyPrefix}:${emailHash}`;
}

/** Comfortably longer than OTP_EXPIRES_IN_SECONDS (an expired code's own entry is no longer
 * useful to either the cooldown check or the "reuse the real sentAt" countdown math) — kept as a
 * literal here rather than importing `@ammari/auth/otp-timing` so this package stays free of a
 * dependency on that one; callers already have that constant in scope and pass it through
 * `getRememberedOtpSendAttempt`'s own `maxAgeMs`, which is the value that actually matters. This
 * is only the outer bound for the opportunistic PRUNE pass below, generous on purpose. */
const PRUNE_HORIZON_MS = 60 * 60 * 1000;
// Same "low enough overhead, high enough frequency" reasoning
// packages/auth/src/shared/email-throttle.ts's CLEANUP_PROBABILITY already uses — this storage
// is write-light (one key per email that actually logs in from this browser), so pruning on
// every write would be wasted work almost every time.
const PRUNE_PROBABILITY = 0.1;

function pruneExpiredEntries(storageKeyPrefix: string, nowMs: number): void {
  if (Math.random() >= PRUNE_PROBABILITY) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(`${storageKeyPrefix}:`)) continue;
      const value = Number(localStorage.getItem(key));
      if (!Number.isFinite(value) || nowMs - value > PRUNE_HORIZON_MS) keysToRemove.push(key);
    }
    for (const key of keysToRemove) localStorage.removeItem(key);
  } catch {
    // localStorage can throw (private-mode quirks, storage disabled) — pruning is pure
    // housekeeping, never required for correctness, so this stays a no-op.
  }
}

/** Records that a real send attempt for `email` happened at `sentAtMs` (call this right after a
 * send call that wasn't itself rejected with a 429 — the server's OWN cooldown no-op is exactly
 * the case this module exists to remember, so it must be recorded as an attempt too). */
export async function rememberOtpSendAttempt(storageKeyPrefix: string, email: string, sentAtMs: number): Promise<void> {
  try {
    const emailHash = await hashEmail(email);
    localStorage.setItem(storageKeyFor(storageKeyPrefix, emailHash), String(sentAtMs));
    pruneExpiredEntries(storageKeyPrefix, sentAtMs);
  } catch {
    // Same "a storage nicety, not a correctness requirement" posture the existing OTP session
    // storage helpers already take — losing this memory just means the UI falls back to
    // behaving as it did before this fix (not a regression, just a missed improvement).
  }
}

/** Returns the remembered send time for `email`, or `null` if there isn't one or it's older than
 * `maxAgeMs` (pass `OTP_EXPIRES_IN_SECONDS * 1000` — once a code's own validity window has
 * passed, there's nothing left to protect, cooldown or otherwise, so a genuinely fresh send is
 * correct). The caller decides what "recent enough to still be in cooldown" means by comparing
 * the returned timestamp against `OTP_RESEND_COOLDOWN_SECONDS` itself — this function only
 * answers "is there a remembered attempt at all, within a sane outer bound." */
export async function getRememberedOtpSendAttempt(storageKeyPrefix: string, email: string, maxAgeMs: number): Promise<number | null> {
  try {
    const emailHash = await hashEmail(email);
    const raw = localStorage.getItem(storageKeyFor(storageKeyPrefix, emailHash));
    if (raw === null) return null;
    const sentAtMs = Number(raw);
    if (!Number.isFinite(sentAtMs)) return null;
    if (Date.now() - sentAtMs > maxAgeMs) return null;
    return sentAtMs;
  } catch {
    return null;
  }
}
