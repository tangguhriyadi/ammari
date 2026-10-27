import "server-only";
import { cache } from "react";
import type { Metadata } from "next";
import { sanitizeInfoPageHtml } from "@ammari/content-sanitize";
import { getPublishedInfoPage, type StorefrontInfoPage } from "@ammari/db/storefront";
import type { InfoPageSlug } from "@ammari/db/schema";
import { infoPageMetaDescription } from "@/lib/seo/descriptions";
import { NOINDEX_ROBOTS } from "@/lib/seo/indexing";
import { buildBreadcrumbJsonLd, HOME_BREADCRUMB_NAME } from "@/lib/seo/json-ld";
import { siteOrigin } from "@/lib/site-origin";

/** One read per request for the page body and its generateMetadata. */
export const getCachedPublishedInfoPage = cache((slug: InfoPageSlug): Promise<StorefrontInfoPage | null> => getPublishedInfoPage(slug));

/** The 5 info pages' metadata (docs/plans/seo.md §2): "Name | Ammari", a description from the
 * published body (else `fallbackDescription`), a canonical URL, and noindex while the page is
 * still the "sedang disiapkan" stub. The OG image is inherited from the root layout. */
export async function infoPageMetadata(slug: InfoPageSlug, name: string, fallbackDescription: string): Promise<Metadata> {
  const page = await getCachedPublishedInfoPage(slug);
  return {
    title: `${name} | Ammari`,
    description: infoPageMetaDescription({ sanitizedBodyHtml: page ? sanitizeInfoPageHtml(page.body) : null, fallback: fallbackDescription }),
    alternates: { canonical: `/${slug}` },
    ...(page ? {} : { robots: NOINDEX_ROBOTS }),
  };
}

export function infoPageBreadcrumb(slug: InfoPageSlug, name: string): Record<string, unknown> {
  const origin = siteOrigin();
  return buildBreadcrumbJsonLd([
    { name: HOME_BREADCRUMB_NAME, url: `${origin}/` },
    { name, url: `${origin}/${slug}` },
  ]);
}
