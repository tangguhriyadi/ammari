import type { StorefrontProductTile } from "@ammari/db/storefront";
import type { FeatureBlockView, HeroView, HomepageProductRefView, HomepageView, ProductGridView, WhyAmmariView } from "./homepage-view";

// Merges a (pure, DB-free) HomepageView with an already-resolved StorefrontProductTile[] (the
// result of calling @ammari/db/storefront's getStorefrontProductTiles against the refs this
// module itself collects) into the final render-ready model — hrefs computed, dangling
// references (a tile/CTA/linked-product pointing at a deleted/unpublished product) dropped. Kept
// separate from homepage-view.ts (which has zero DB-shaped imports) so that module stays
// trivially unit-testable without even a mock DB client; this one's own tests simply hand it a
// canned `StorefrontProductTile[]` instead of hitting a real database.

function refKey(ref: { productId: string; fabricColorId: string | null }): string {
  return `${ref.productId}:${ref.fabricColorId ?? ""}`;
}

/** Every distinct product/colour reference embedded in a HomepageView that needs resolving
 * against the live catalog — hero's product CTA target (if any), every grid tile, and the
 * feature block's linked product. Call this BEFORE `getStorefrontProductTiles`, then pass its
 * result into `resolveHomepageView` below. */
export function collectHomepageProductRefs(view: HomepageView): HomepageProductRefView[] {
  const refs: HomepageProductRefView[] = [];
  if (view.hero?.ctaTarget.type === "product") refs.push(view.hero.ctaTarget.ref);
  if (view.productGrid) refs.push(...view.productGrid.tiles);
  if (view.featureBlock) refs.push(view.featureBlock.linkedProduct);

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ResolvedHero extends Omit<HeroView, "ctaTarget"> {
  /** "#koleksi" for an anchor target, or an unresolved/dangling product target (never a dead
   * link to a since-deleted product). */
  ctaHref: string;
}

export interface ResolvedProductGrid extends Omit<ProductGridView, "tiles"> {
  tiles: StorefrontProductTile[];
}

export interface ResolvedFeatureBlock extends Omit<FeatureBlockView, "linkedProduct"> {
  linkedProduct: StorefrontProductTile;
  href: string;
}

export interface ResolvedHomepageView {
  hero: ResolvedHero | null;
  productGrid: ResolvedProductGrid | null;
  featureBlock: ResolvedFeatureBlock | null;
  whyAmmari: WhyAmmariView | null;
}

function productHref(tile: StorefrontProductTile): string {
  return tile.fabricColorId ? `/products/${tile.slug}?color=${tile.fabricColorId}` : `/products/${tile.slug}`;
}

/** `resolvedTiles` is whatever `getStorefrontProductTiles(collectHomepageProductRefs(view))`
 * returned — a ref whose product no longer resolves (deleted, deactivated, unpublished since the
 * section was curated) is simply absent from it, per that function's own "skip, never crash"
 * contract. This function turns that into the final render decision: hero falls back its CTA to
 * the "#koleksi" anchor; a grid with zero resolvable tiles, or a feature block whose one linked
 * product didn't resolve, is treated as empty and not rendered at all — same "hidden/empty
 * sections not rendered" rule `buildHomepageView` already applies to the raw CMS content. */
export function resolveHomepageView(view: HomepageView, resolvedTiles: StorefrontProductTile[]): ResolvedHomepageView {
  const tileByKey = new Map(resolvedTiles.map((tile) => [refKey({ productId: tile.productId, fabricColorId: tile.fabricColorId }), tile]));

  let hero: ResolvedHero | null = null;
  if (view.hero) {
    const { ctaTarget, ...rest } = view.hero;
    const resolvedTarget = ctaTarget.type === "product" ? tileByKey.get(refKey(ctaTarget.ref)) : undefined;
    hero = { ...rest, ctaHref: resolvedTarget ? productHref(resolvedTarget) : "#koleksi" };
  }

  let productGrid: ResolvedProductGrid | null = null;
  if (view.productGrid) {
    const tiles = view.productGrid.tiles.map((ref) => tileByKey.get(refKey(ref))).filter((tile): tile is StorefrontProductTile => tile !== undefined);
    if (tiles.length > 0) productGrid = { title: view.productGrid.title, tiles };
  }

  let featureBlock: ResolvedFeatureBlock | null = null;
  if (view.featureBlock) {
    const linkedProduct = tileByKey.get(refKey(view.featureBlock.linkedProduct));
    if (linkedProduct) {
      featureBlock = {
        title: view.featureBlock.title,
        subtitle: view.featureBlock.subtitle,
        ctaLabel: view.featureBlock.ctaLabel,
        image: view.featureBlock.image,
        linkedProduct,
        href: productHref(linkedProduct),
      };
    }
  }

  return { hero, productGrid, featureBlock, whyAmmari: view.whyAmmari };
}
