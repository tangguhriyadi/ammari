import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getRelatedStorefrontProducts, getStorefrontProductBySlug, type StorefrontProduct } from "@ammari/db/storefront";
import type { CachedProductTile, StorefrontPricingInput } from "./storefront-price";

// `/products/[slug]` is `dynamic = "force-dynamic"` (docs/plans/product-discount.md §7): the page
// renders per request so the price is resolved with that request's `now`, exact at a discount's
// start and end. Its DB reads are cached HERE instead, with the RAW pricing fields, the same
// pattern lib/content/homepage-data.ts uses for `/`.
//
// The tags are the only thing that refreshes these before the 1h TTL. apps/admin's
// lib/revalidate.ts MUST send these exact strings (hand-synced, same posture as
// HOMEPAGE_CACHE_TAG); lib/payments/revalidate.ts uses them directly.

/** One product's own PDP data. */
export function productCacheTag(slug: string): string {
  return `storefront:product:${slug}`;
}

/** Every "Lengkapi koleksimu" list: it shows OTHER products, so any product save refreshes it. */
export const PRODUCTS_CACHE_TAG = "storefront:products";

const PRODUCT_CACHE_REVALIDATE_SECONDS = 3600;

/** A product as it comes out of the cache: a hit returns the discount window as ISO strings. */
export type CachedStorefrontProduct = Omit<StorefrontProduct, "pricing"> & { pricing: StorefrontPricingInput };

/** Thrown inside the cached function for an unknown slug: a rejection is never cached, so any URL
 * a visitor makes up costs one DB read and no cache entry, and a product published later shows
 * on its first request. */
class ProductNotFound extends Error {}

/** Cached per slug, positive results only. `unstable_cache` needs its tags up front, so the wrapper
 * is built per call; the entry is keyed by the key parts plus the slug argument, so calls share it.
 * `cache` dedupes the page body and generateMetadata within one request. */
export const getCachedStorefrontProduct = cache(async (slug: string): Promise<CachedStorefrontProduct | null> => {
  try {
    return await unstable_cache(
      async (productSlug: string): Promise<CachedStorefrontProduct> => {
        const product = await getStorefrontProductBySlug(productSlug);
        if (!product) throw new ProductNotFound(productSlug);
        return product;
      },
      ["storefront-product"],
      { tags: [productCacheTag(slug)], revalidate: PRODUCT_CACHE_REVALIDATE_SECONDS },
    )(slug);
  } catch (error) {
    if (error instanceof ProductNotFound) return null;
    throw error;
  }
});

export const getCachedRelatedProducts = unstable_cache(
  (excludeSlug: string, limit: number): Promise<CachedProductTile[]> => getRelatedStorefrontProducts({ excludeSlug, limit }),
  ["storefront-related-products"],
  { tags: [PRODUCTS_CACHE_TAG], revalidate: PRODUCT_CACHE_REVALIDATE_SECONDS },
);
