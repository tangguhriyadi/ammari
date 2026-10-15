import type { MetadataRoute } from "next";

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
// up indexed by a misconfiguration.
export default function robots(): MetadataRoute.Robots {
  if (process.env.DEPLOY_ENV === "production") {
    return { rules: { userAgent: "*", allow: "/" } };
  }
  return { rules: { userAgent: "*", disallow: "/" } };
}
