import type { Metadata } from "next";

// Who may be indexed (docs/plans/seo.md §2). Pure: every caller passes `process.env.DEPLOY_ENV`
// itself, read at request time, never at `next build` (the image is environment-neutral, see
// app/robots.ts).

/** Only the literal "production" is indexable. Anything else (unset, "dev", a typo) is not, so a
 * misconfigured host fails safe: never indexed. Same rule app/robots.ts has always used. */
export function isIndexableDeployment(deployEnv: string | undefined): boolean {
  return deployEnv === "production";
}

/** Routes that are never indexed in any environment: per-visitor pages, token links, the draft
 * preview, and every API route (internal, webhooks, e2e-only). None of them is ever in the
 * sitemap. `/claim` covers `/claim/<token>`. */
export const PRIVATE_PATH_PREFIXES = ["/cart", "/checkout", "/account", "/orders", "/login", "/claim", "/consent", "/preview", "/api"] as const;

/** Exact match or a `/`-bounded prefix, so `/accounting` is not `/account`. */
export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export const NOINDEX_HEADER_VALUE = "noindex, nofollow";

/** The `X-Robots-Tag` value for a response, or null for none: every path off production, private
 * paths everywhere. Also covers non-HTML responses (images, JSON) that a meta tag cannot. */
export function xRobotsTagFor(pathname: string, deployEnv: string | undefined): string | null {
  if (!isIndexableDeployment(deployEnv) || isPrivatePath(pathname)) return NOINDEX_HEADER_VALUE;
  return null;
}

/** `metadata.robots` for a page that must never be indexed. */
export const NOINDEX_ROBOTS: NonNullable<Metadata["robots"]> = { index: false, follow: false };

/** `metadata.robots` for a public page: indexable only on production. A page's own `robots`
 * replaces the layout's, so a public page that sets other robots fields must use this. */
export function publicPageRobots(deployEnv: string | undefined): NonNullable<Metadata["robots"]> {
  return isIndexableDeployment(deployEnv) ? { index: true, follow: true } : NOINDEX_ROBOTS;
}
