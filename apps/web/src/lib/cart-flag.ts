import "server-only";

/** Feature flag for the "Tambah ke keranjang" UI (docs/plans/storefront-cms.md session 7 scope —
 * cart/checkout itself is Dec 2026, unbuilt). Defaults OFF: anything other than the literal
 * string "true" (unset, "false", a typo) keeps cart UI hidden, same fail-closed posture
 * `app/robots.ts`'s `DEPLOY_ENV` check uses.
 *
 * Deliberately server-only, NOT a `NEXT_PUBLIC_` variable: this repo's Docker images are built
 * once and deployed environment-neutral (docs/deploy.md), and a `NEXT_PUBLIC_` value is baked
 * into the client bundle at `next build` time — unflippable per-environment without a rebuild,
 * which defeats the point of a deploy-time rollout flag. Read here on the server (the PDP's
 * page.tsx) and passed down as a plain boolean prop to the one client component that needs it. */
export function isCartEnabled(): boolean {
  return process.env.STOREFRONT_CART_ENABLED === "true";
}
