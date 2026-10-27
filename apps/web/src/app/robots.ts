import type { MetadataRoute } from "next";
import { isIndexableDeployment } from "@/lib/seo/indexing";
import { siteOrigin } from "@/lib/site-origin";

// Without this, Next treats robots.ts as a static metadata route and prerenders it ONCE at
// `next build` time using whatever DEPLOY_ENV happened to be set in the (placeholder-only, see
// Dockerfile) build environment — baking a single environment's answer into the image forever,
// defeating the entire point of DEPLOY_ENV being a runtime-only difference. Confirmed by an
// actual build: without this line, /robots.txt showed up as static ("○") output, not dynamic.
export const dynamic = "force-dynamic";

// The ONE env var that differs between the dev and prod runtime env files for an otherwise
// identical image (docs/plans/deploy-dev.md) — every other difference between environments is
// already covered by the usual per-environment secrets/URLs. Fails safe: anything other than the
// literal "production" (unset, "dev", a typo) serves disallow-all, so a dev host can never end
// up indexed by a misconfiguration (lib/seo/indexing.ts).
//
// Production disallows only /api/. The private pages (cart, account, orders, ...) are NOT
// disallowed here on purpose: they carry `noindex` (meta + X-Robots-Tag, src/proxy.ts), and a
// crawler has to be allowed to fetch a page to see that; a disallowed URL linked from every
// page's header can still be indexed bare (docs/plans/seo.md §2).
export default function robots(): MetadataRoute.Robots {
  if (isIndexableDeployment(process.env.DEPLOY_ENV)) {
    return { rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: `${siteOrigin()}/sitemap.xml` };
  }
  return { rules: { userAgent: "*", disallow: "/" } };
}
