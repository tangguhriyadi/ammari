import type { ResolvedHomepageView } from "@/lib/content/homepage-resolve";
import { HeroSection } from "./hero-section";
import { ProductGridSection } from "./product-grid-section";
import { WhyAmmariSection } from "./why-ammari-section";
import { FeatureBlockSection } from "./feature-block-section";

/** Renders every resolved homepage section in the fixed canonical order (docs/design/
 * storefront.md §5), skipping any that are `null` (hidden, never published, or empty after
 * resolution — see homepage-resolve.ts). The ONE component both `/` and `/preview/home` render,
 * so the draft preview looks exactly like the real page (docs/plans/storefront-cms.md session
 * 7's own requirement) — the only difference between the two routes is which read function
 * (published vs. draft) fed the `ResolvedHomepageView` in the first place. */
export function HomepageSections({ view }: { view: ResolvedHomepageView }) {
  return (
    <>
      {view.hero && <HeroSection hero={view.hero} />}
      {view.productGrid && <ProductGridSection grid={view.productGrid} />}
      {view.whyAmmari && <WhyAmmariSection section={view.whyAmmari} />}
      {view.featureBlock && <FeatureBlockSection block={view.featureBlock} />}
    </>
  );
}
