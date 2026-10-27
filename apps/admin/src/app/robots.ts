import type { MetadataRoute } from "next";

// The admin is never indexed, in any environment (docs/plans/seo.md): disallow everything. Static
// on purpose, no DEPLOY_ENV: unlike the storefront there is no environment where this changes.
// Reachable without a session (src/proxy.ts PUBLIC_PATHS).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
