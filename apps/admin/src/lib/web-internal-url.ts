import "server-only";

/** apps/web's INTERNAL (Docker network) base URL — e.g. `http://web:3000` on the deployed VPS,
 * `http://localhost:3000` locally. Deliberately separate from `main-site-url.ts`'s
 * `MAIN_SITE_URL` (the PUBLIC hostname, behind Cloudflare/Caddy's Authenticated Origin Pulls
 * gate): a plain server-to-server `fetch` to the public hostname has no client certificate and
 * would fail that gate. `WEB_INTERNAL_URL` is what `/api/revalidate` calls are made against —
 * see lib/revalidate.ts and docs/plans/storefront-cms.md session 6's "Grounding" section.
 *
 * Unlike MAIN_SITE_URL, this is never required to be https — it never leaves the Docker
 * network. Same lazy-validate-once-and-cache idiom as main-site-url.ts/storage.ts. */
let cached: string | undefined;

function validate(): string {
  if (cached) return cached;

  const raw = process.env.WEB_INTERNAL_URL;
  if (!raw) {
    throw new Error(
      "WEB_INTERNAL_URL is not set. This must be apps/web's INTERNAL base URL (e.g. " +
        "http://localhost:3000 locally, http://web:3000 on the deployed Docker network) — see " +
        "deploy/env/admin.env.example.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`WEB_INTERNAL_URL ("${raw}") is not a valid absolute URL.`);
  }
  if (raw.endsWith("/")) {
    throw new Error(`WEB_INTERNAL_URL ("${raw}") must not have a trailing slash.`);
  }
  void parsed; // parsed only to validate the string is a real absolute URL

  cached = raw;
  return cached;
}

export function getWebInternalUrl(): string {
  return validate();
}

/** Test-only reset — mirrors main-site-url.ts's own `__resetMainSiteUrlForTests`. */
export function __resetWebInternalUrlForTests(): void {
  cached = undefined;
}
