import type { Metadata } from "next";
import { buildHomepageView } from "@/lib/content/homepage-view";
import { collectHomepageProductRefs, resolveHomepageView } from "@/lib/content/homepage-resolve";
import { getCachedHomepageProductTiles, getCachedPublishedHomepageContent } from "@/lib/content/homepage-data";
import { HomepageSections } from "@/components/homepage/homepage-sections";

// `/` has no dynamic route segment, so without this Next would attempt to prerender it once
// during `next build` itself — which runs against a non-connecting placeholder DATABASE_URL in
// this repo's Docker build (apps/web/Dockerfile; confirmed empirically: an actual `next build`
// run against that exact placeholder throws ECONNREFUSED on the first real query). An earlier
// version of this page worked around that by special-casing the build phase to render an empty
// view instead — but that empty, build-time-rendered HTML then shipped as the page's ISR cache
// entry and was served as-is after every fresh deploy, for up to the 1h `revalidate` window, even
// though real published content already existed in the database (this is exactly the bug: the
// homepage rendered blank right after a deploy until someone re-published, which only triggers
// revalidation as a side effect).
//
// `force-dynamic` removes the build-time prerender attempt entirely — this route is now always
// rendered at request time, from the real database, same as `/products/[slug]` already was (see
// that page's own comment on why it never hit this bug: no `generateStaticParams` means Next
// never attempts to prerender ANY concrete slug at build either). The DB reads this page needs
// are cached independently via `unstable_cache` (lib/content/homepage-data.ts) so re-rendering on
// every request doesn't mean a database query on every request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ammari | Graceful in every thread",
  description: "Ammari, syar'i gamis. Desain syar'i, bahan premium, nyaman dipakai seharian.",
};

async function getHomepageView() {
  const sections = await getCachedPublishedHomepageContent();
  const view = buildHomepageView(sections);
  const refs = collectHomepageProductRefs(view);
  const tiles = refs.length > 0 ? await getCachedHomepageProductTiles(refs) : [];
  return resolveHomepageView(view, tiles);
}

export default async function HomePage() {
  const view = await getHomepageView();
  return <HomepageSections view={view} />;
}
