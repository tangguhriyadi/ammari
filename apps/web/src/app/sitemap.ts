import type { MetadataRoute } from "next";
import { getStorefrontSitemapData } from "@ammari/db/storefront";
import { buildSitemap } from "@/lib/seo/sitemap";
import { siteOrigin } from "@/lib/site-origin";

// Read per request, like robots.ts: never prerendered at `next build` (no database there, see
// app/page.tsx's own comment), and always current after an admin save. Three small indexed
// reads; crawlers fetch this rarely. A failed read is a 500, never an empty sitemap: an empty one
// would tell crawlers every product is gone.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(siteOrigin(), await getStorefrontSitemapData());
}
