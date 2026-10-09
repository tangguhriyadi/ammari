import "server-only";

/** Lazy singleton, same "validate on first real use, cache after, throw loudly rather than
 * silently fall back" idiom `src/lib/storage.ts`'s `getStorageClient` already uses for its own
 * env-derived config — chosen over a top-level-throwing module constant (the OTHER existing
 * idiom, `packages/db/src/client.ts`'s `DATABASE_URL`) specifically because this one is directly
 * testable by mutating `process.env` before calling it, the same way `storage.test.ts` already
 * tests `getStorageClient`. */
let cached: { url: string; host: string } | undefined;

function validate(): { url: string; host: string } {
  if (cached) return cached;

  const raw = process.env.MAIN_SITE_URL;
  if (!raw) {
    throw new Error(
      "MAIN_SITE_URL is not set. This must be apps/web's public base URL (e.g. " +
        "http://localhost:3000 locally, https://ammari.my.id on dev, https://ammari.id in " +
        "production) — see apps/admin/.env.example.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MAIN_SITE_URL ("${raw}") is not a valid absolute URL.`);
  }
  // Checked against the raw string, not `parsed.pathname` — the WHATWG URL parser normalizes an
  // empty path to "/" on the parsed object regardless of what was typed, so comparing there
  // would never catch a trailing slash at all.
  if (raw.endsWith("/")) {
    throw new Error(`MAIN_SITE_URL ("${raw}") must not have a trailing slash.`);
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error(`MAIN_SITE_URL ("${raw}") must use https when NODE_ENV=production.`);
  }

  cached = { url: raw, host: parsed.host };
  return cached;
}

/** apps/web's full public base URL, no trailing slash — e.g. "https://ammari.id". Use this to
 * build any absolute URL pointing at the main site (the QR's own encoded content). */
export function getMainSiteUrl(): string {
  return validate().url;
}

/** Just the host, no protocol — e.g. "ammari.id" or "localhost:3000" (port included when
 * present). Use this for anything meant to be READ by a human rather than scanned/clicked (the
 * card's printed fallback text) — SPEC's claim-flow design never relies on the scheme being
 * visible there. */
export function getMainSiteHost(): string {
  return validate().host;
}

/** Test-only reset — mirrors storage.ts's own `__setStorageClientForTests`, so a test can change
 * `process.env.MAIN_SITE_URL` and re-validate instead of being stuck with whatever the first
 * call in the process cached. */
export function __resetMainSiteUrlForTests(): void {
  cached = undefined;
}
