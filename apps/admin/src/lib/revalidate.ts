import "server-only";
import { getWebInternalUrl } from "./web-internal-url";

// Calls apps/web's secret-gated /api/revalidate over the INTERNAL Docker network (WEB_INTERNAL_URL,
// e.g. http://web:3000 — never the public MAIN_SITE_URL, see web-internal-url.ts and
// docs/plans/storefront-cms.md session 6's "Grounding" section). A failed call NEVER throws —
// every caller (publishHomepageAction, the product save actions) must keep succeeding even when
// this fails; the 1-hour `revalidate = 3600` fallback on apps/web's own pages is the correctness
// floor underneath this. Logged loudly on failure (never silently dropped), same posture this
// codebase already takes for payments/OTP email.

export interface RevalidateOutcome {
  ok: boolean;
}

function getRevalidateSecret(): string | null {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    console.error("REVALIDATE_SECRET is not set — cannot call apps/web's /api/revalidate.");
    return null;
  }
  return secret;
}

async function postRevalidate(paths: readonly string[]): Promise<RevalidateOutcome> {
  const secret = getRevalidateSecret();
  if (!secret) return { ok: false };

  try {
    const response = await fetch(`${getWebInternalUrl()}/api/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`revalidate: apps/web responded ${response.status} for paths [${paths.join(", ")}]`);
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.error(`revalidate: request to apps/web failed for paths [${paths.join(", ")}]`, error);
    return { ok: false };
  }
}

/** After the homepage "Terbitkan" action — the only path that can change what `/` shows. */
export function revalidateHomepage(): Promise<RevalidateOutcome> {
  return postRevalidate(["/"]);
}

/** After any save that could change a product's storefront page — the product's own slug AND
 * `/`, since a homepage tile can reference this product (docs/plans/storefront-cms.md session
 * 6). Called unconditionally on every relevant product save, not gated on
 * `is_published_on_storefront`: that keeps the unpublish transition (published -> hidden) and
 * every other edit correctly revalidated without the action layer having to track a before/after
 * diff of that flag itself — the extra internal-network call for an unpublished product is
 * cheap, and a path that was never live simply has nothing to show either way. */
export function revalidateProductSlug(slug: string): Promise<RevalidateOutcome> {
  return postRevalidate([`/products/${slug}`, "/"]);
}
