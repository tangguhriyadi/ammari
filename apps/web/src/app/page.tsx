import type { Metadata } from "next";
import { getPublishedHomepageContent, getStorefrontProductTiles } from "@ammari/db/storefront";
import { buildHomepageView } from "@/lib/content/homepage-view";
import { collectHomepageProductRefs, resolveHomepageView } from "@/lib/content/homepage-resolve";
import { isProductionBuildPhase } from "@/lib/build-phase";
import { HomepageSections } from "@/components/homepage/homepage-sections";

// Defense-in-depth fallback — the primary revalidation path is on-demand, via apps/admin calling
// POST /api/revalidate right after "Terbitkan" (docs/plans/storefront-cms.md session 6). See
// lib/build-phase.ts for why this page's own data-fetching guards against querying the database
// during `next build` itself.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Ammari — Graceful in every thread",
  description: "Ammari — syar'i gamis. Desain syar'i, bahan premium, nyaman dipakai seharian.",
};

async function getHomepageView() {
  // See lib/build-phase.ts's own doc comment — this page has no dynamic route segment, so Next
  // attempts to prerender it once during `next build` itself, which runs against a non-connecting
  // placeholder DATABASE_URL in this repo's Docker build (confirmed empirically). Querying the
  // real DB only ever happens at actual runtime (next start / a real request), never during that
  // one build-time pass.
  if (isProductionBuildPhase()) {
    return resolveHomepageView(buildHomepageView([]), []);
  }

  const sections = await getPublishedHomepageContent();
  const view = buildHomepageView(sections);
  const refs = collectHomepageProductRefs(view);
  const tiles = refs.length > 0 ? await getStorefrontProductTiles(refs) : [];
  return resolveHomepageView(view, tiles);
}

export default async function HomePage() {
  const view = await getHomepageView();
  return <HomepageSections view={view} />;
}
