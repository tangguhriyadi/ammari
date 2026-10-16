import "server-only";
import { unstable_cache } from "next/cache";
import {
  getPublishedHomepageContent,
  getStorefrontProductTiles,
  type StorefrontProductTileRef,
} from "@ammari/db/storefront";

// `/` (app/page.tsx) is `dynamic = "force-dynamic"` — Next never attempts to prerender it at
// `next build` (where the DB is unreachable, see apps/web/Dockerfile), so there is no stale
// build-time snapshot to serve after a fresh deploy. That means this page now re-runs on every
// request, so the DB reads it needs are cached HERE instead, with `unstable_cache`, to avoid a
// query on every single request. This tag is the ONLY thing that invalidates that cache before
// its 1h TTL — apps/admin's own copy (apps/admin/src/lib/revalidate.ts) MUST use this exact
// string; keep the two in sync by hand (same posture this codebase already takes for the
// "x-revalidate-secret" header name shared between apps/web's /api/revalidate route and
// apps/admin's caller).
export const HOMEPAGE_CACHE_TAG = "storefront:homepage";

const HOMEPAGE_CACHE_REVALIDATE_SECONDS = 3600;

export const getCachedPublishedHomepageContent = unstable_cache(
  () => getPublishedHomepageContent(),
  ["storefront-homepage-content"],
  { tags: [HOMEPAGE_CACHE_TAG], revalidate: HOMEPAGE_CACHE_REVALIDATE_SECONDS },
);

// Tagged the same as the homepage content above (not a per-product tag): apps/admin already
// calls revalidateProductSlug() unconditionally on every product save regardless of whether that
// product is actually referenced by a homepage tile (see that function's own doc comment), so
// reusing one shared tag here preserves that same conservative "any product save refreshes the
// homepage" behavior without the admin side needing to know which products the homepage
// currently references.
export const getCachedHomepageProductTiles = unstable_cache(
  (refs: StorefrontProductTileRef[]) => getStorefrontProductTiles(refs),
  ["storefront-homepage-tiles"],
  { tags: [HOMEPAGE_CACHE_TAG], revalidate: HOMEPAGE_CACHE_REVALIDATE_SECONDS },
);
