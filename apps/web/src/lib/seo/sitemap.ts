import type { MetadataRoute } from "next";
import type { StorefrontSitemapData } from "@ammari/db/storefront";
import { isPrivatePath } from "./indexing";

// sitemap.xml contents (docs/plans/seo.md §2). Pure: app/sitemap.ts reads the data and the origin.

type DateLike = Date | string | null;

function toDate(value: DateLike): Date | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Home, every published info page, every active + published product, each at its canonical URL
 * (no query, no fragment). `lastModified` comes from the data and is left out when unknown rather
 * than invented. Private paths can never appear, even if a future slug collided with one. */
export function buildSitemap(origin: string, data: StorefrontSitemapData): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    { url: `${origin}/`, lastModified: toDate(data.homepagePublishedAt), changeFrequency: "daily", priority: 1 },
    ...data.products.map((product) => ({
      url: `${origin}/products/${encodeURIComponent(product.slug)}`,
      lastModified: toDate(product.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
    ...data.infoPages.map((page) => ({
      url: `${origin}/${page.slug}`,
      lastModified: toDate(page.publishedAt),
      changeFrequency: "monthly" as const,
      priority: 0.3,
    })),
  ];
  return entries
    .filter((entry) => !isPrivatePath(new URL(entry.url).pathname))
    .map((entry) => (entry.lastModified === undefined ? { url: entry.url, changeFrequency: entry.changeFrequency, priority: entry.priority } : entry));
}
