/** The storefront's own public origin, no trailing slash. Same env var Better Auth uses as its
 * baseURL (apps/web/.env.example), and the root layout's `metadataBase`. */
export function siteOrigin(): string {
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
