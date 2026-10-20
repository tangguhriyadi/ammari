import "server-only";
import { revalidatePath } from "next/cache";

// Admin-side cache invalidation after a successful mutation. NOT the storefront one (that's
// lib/revalidate.ts, a network call to apps/web) — this only concerns apps/admin's own pages.
//
// Every admin page is dynamic (session-gated, uncached DB reads), so there is no server-side
// cache to clear; what goes stale is the browser's Client Cache (prefetched and back/forward
// RSC payloads). A `router.refresh()` only clears the CURRENT route's entry, which is the wrong
// one for a form that saves and then `router.push()`es to a list or detail page. Calling
// `revalidatePath` inside the Server Action instead marks the action response as revalidated,
// and the client router then drops its cached payloads and re-renders the current page in the
// same round trip — so whatever the form navigates to next is fetched fresh.
//
// Each section is revalidated as a LAYOUT path, so the list page and every detail/sub-page under
// it are covered by one call. The `(shell)` route-group prefix is required: `revalidatePath`
// matches tags derived from the route's file path, which includes the group segment
// (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md).
export type AdminSection =
  | "/accessories"
  | "/content"
  | "/fabrics"
  | "/orders"
  | "/packing"
  | "/production"
  | "/products"
  | "/purchases"
  | "/receipts"
  | "/stock"
  | "/suppliers";

/** Call only after the mutation has committed (inside `runAction`'s callback, after the write),
 * naming every section whose pages render the changed data, not just the one the form returns to. */
export function revalidateAdmin(...sections: AdminSection[]): void {
  for (const section of sections) revalidatePath(`/(shell)${section}`, "layout");
}
