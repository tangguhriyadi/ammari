import "server-only";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

/** True only while `next build` is actually executing (never at real runtime, `next dev`, or
 * `next start`/the standalone `server.js`) — `process.env.NEXT_PHASE` is a Next.js-internal value
 * (`next/constants`'s `PHASE_PRODUCTION_BUILD`), not something this app sets itself.
 *
 * Needed because `/` has no dynamic route segment, so unlike `/products/[slug]` (which Next
 * defers to first real request — no `generateStaticParams`, see that page's own comment), Next
 * attempts to prerender `/` once during `next build` itself to produce its initial ISR snapshot.
 * Per apps/web/Dockerfile, this image is built ONCE in CI with a placeholder, non-connecting
 * `DATABASE_URL` and deployed environment-neutral — confirmed empirically (an actual `next build`
 * run against that exact placeholder) that querying the real DB during that prerender pass hard-
 * fails the whole build with `ECONNREFUSED`. `/`'s data-fetching wrapper checks this flag and
 * returns an empty view instead of querying the DB ONLY during that one build-time pass; the
 * resulting static HTML is empty until the first real revalidation (the 3600s window, or an
 * on-demand "Terbitkan"/product-save call from apps/admin) regenerates it against the real,
 * reachable production database — same "empty until the owner publishes" state a fresh deploy is
 * already in regardless. */
export function isProductionBuildPhase(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}
