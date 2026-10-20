import "server-only";
import type { Metadata } from "next";
import { HERO_OG_IMAGE_HEIGHT, HERO_OG_IMAGE_WIDTH } from "@ammari/db/storefront-settings";
import { getStoragePublicBaseUrl } from "@/lib/storage/public-url";
import { siteOrigin } from "@/lib/site-origin";
import { getCachedPublishedHeroOgImage } from "./homepage-data";
import { PRODUCT_PLACEHOLDER_OG_PATH } from "./product-placeholder";

export interface SiteOgImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

/** Same 1200x630 JPEG the product pages fall back to (product-placeholder.ts). */
const PLACEHOLDER_ALT = "Ammari";

function placeholderOgImage(): SiteOgImage {
  return { url: `${siteOrigin()}${PRODUCT_PLACEHOLDER_OG_PATH}`, width: HERO_OG_IMAGE_WIDTH, height: HERO_OG_IMAGE_HEIGHT, alt: PLACEHOLDER_ALT };
}

/** The OG image for "/" and every non-product page: the 1200x630 JPEG apps/admin generates from
 * the PUBLISHED Hero (lib/content/hero-og-image.ts there), as an absolute URL on the public image
 * domain, or the static placeholder when there is none. Cached under the homepage tag, so
 * publishing a new Hero updates it on the next request. Never throws: a DB or config failure here
 * must not break every page's metadata, so it logs and falls back. */
export async function getSiteOgImage(): Promise<SiteOgImage> {
  try {
    const hero = await getCachedPublishedHeroOgImage();
    if (!hero) return placeholderOgImage();
    return { url: `${getStoragePublicBaseUrl()}/${hero.key}`, width: HERO_OG_IMAGE_WIDTH, height: HERO_OG_IMAGE_HEIGHT, alt: hero.altText };
  } catch (error) {
    console.error("site-og-image: failed to resolve the Hero OG image, using the placeholder", error);
    return placeholderOgImage();
  }
}

/** The `openGraph.images` + `twitter` part of a page's Metadata for the site OG image. `twitter`
 * names only the card type: Next fills twitter:image/title/description from openGraph itself, and
 * leaving `twitter.images` unset is what keeps a product page's own openGraph image flowing into
 * its twitter:image instead of this one being inherited from the root layout. */
export function siteOgImageMetadata(image: SiteOgImage): { images: NonNullable<Metadata["openGraph"]>["images"]; twitter: Metadata["twitter"] } {
  return {
    images: [{ url: image.url, width: image.width, height: image.height, alt: image.alt, type: "image/jpeg" }],
    twitter: { card: "summary_large_image" },
  };
}
