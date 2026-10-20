import "server-only";
import { getWebInternalUrl } from "./web-internal-url";

// Calls apps/web's secret-gated /api/revalidate over the INTERNAL Docker network (WEB_INTERNAL_URL,
// e.g. http://web:3000 — never the public MAIN_SITE_URL, see web-internal-url.ts and
// docs/plans/storefront-cms.md session 6's "Grounding" section). A failed call NEVER throws —
// every caller (publishHomepageAction, the product save actions) must keep succeeding even when
// this fails; the 1-hour cache TTL underneath apps/web's own homepage data cache
// (lib/content/homepage-data.ts) and `/products/[slug]`'s `revalidate = 3600` are the
// correctness floor underneath this. Logged loudly on failure (never silently dropped), same
// posture this codebase already takes for payments/OTP email.

// MUST match apps/web's lib/content/homepage-data.ts's own `HOMEPAGE_CACHE_TAG` exactly — kept as
// a hand-synced literal rather than a shared import, same posture this codebase already takes
// for the "x-revalidate-secret" header name itself (no package boundary between these two Next
// apps covers a one-line cache-tag string). `/` (apps/web's homepage) is `dynamic =
// "force-dynamic"`, so it has no route-level ISR cache for `revalidatePath("/")` to invalidate
// any more — this tag is the only thing that actually refreshes it on demand.
const HOMEPAGE_CACHE_TAG = "storefront:homepage";

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

async function postRevalidate(payload: {
  paths?: readonly string[];
  layouts?: readonly string[];
  tags?: readonly string[];
}): Promise<RevalidateOutcome> {
  const secret = getRevalidateSecret();
  if (!secret) return { ok: false };

  const description = [
    ...(payload.paths ?? []),
    ...(payload.layouts?.map((layout) => `layout:${layout}`) ?? []),
    ...(payload.tags?.map((tag) => `tag:${tag}`) ?? []),
  ].join(", ");
  try {
    const response = await fetch(`${getWebInternalUrl()}/api/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`revalidate: apps/web responded ${response.status} for [${description}]`);
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.error(`revalidate: request to apps/web failed for [${description}]`, error);
    return { ok: false };
  }
}

/** After the homepage "Terbitkan" action — the only thing that can change what `/` shows. */
export function revalidateHomepage(): Promise<RevalidateOutcome> {
  return postRevalidate({ tags: [HOMEPAGE_CACHE_TAG] });
}

/** After any save that could change a product's storefront page — the product's own slug (its
 * ISR-cached `/products/[slug]` route) AND the homepage cache tag, since a homepage tile can
 * reference this product (docs/plans/storefront-cms.md session 6). Called unconditionally on
 * every relevant product save, not gated on `is_published_on_storefront`: that keeps the
 * unpublish transition (published -> hidden) and every other edit correctly revalidated without
 * the action layer having to track a before/after diff of that flag itself — the extra
 * internal-network call for an unpublished product is cheap, and a path that was never live
 * simply has nothing to show either way. */
export function revalidateProductSlug(slug: string): Promise<RevalidateOutcome> {
  return postRevalidate({ paths: [`/products/${slug}`], tags: [HOMEPAGE_CACHE_TAG] });
}

/** apps/web's /api/revalidate accepts at most 10 paths per request. */
const MAX_PATHS_PER_REQUEST = 10;

/** After a stock change: every affected product's page plus the homepage tag, deduplicated and
 * batched (one POST per 10 products, never one per product). An empty list makes no call. Like
 * every function here it never throws; `ok` is false if ANY batch failed. */
export async function revalidateProductSlugs(slugs: readonly string[]): Promise<RevalidateOutcome> {
  const unique = [...new Set(slugs)];
  const requests: Promise<RevalidateOutcome>[] = [];
  for (let i = 0; i < unique.length; i += MAX_PATHS_PER_REQUEST) {
    const batch = unique.slice(i, i + MAX_PATHS_PER_REQUEST);
    requests.push(postRevalidate({ paths: batch.map((slug) => `/products/${slug}`), tags: [HOMEPAGE_CACHE_TAG] }));
  }
  // In parallel: a down storefront costs one timeout, not one per batch.
  const results = await Promise.all(requests);
  return { ok: results.every((result) => result.ok) };
}

/** After a store settings save (Pengaturan Toko). The settings are read uncached, but they render
 * in apps/web's ROOT layout (announcement bar, footer contact) on every page, and the
 * `/products/[slug]` pages are ISR-cached for up to an hour with that layout baked in. Revalidating
 * the root LAYOUT path refreshes every page beneath it, and the homepage tag refreshes `/`'s own
 * cached data. */
export function revalidateStorefrontLayout(): Promise<RevalidateOutcome> {
  return postRevalidate({ layouts: ["/"], tags: [HOMEPAGE_CACHE_TAG] });
}

// Info pages (session 8) are NOT revalidated here, on purpose: they are `dynamic =
// "force-dynamic"` with a plain, uncached `getPublishedInfoPage` call on apps/web. An earlier
// version of this plan cached them with `unstable_cache`, matching the homepage's own pattern,
// reverted after it did not reliably reflect a fresh publish within the same apps/web server
// lifetime. With nothing cached, there is nothing to revalidate.
