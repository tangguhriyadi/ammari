import "server-only";
import { revalidateTag } from "next/cache";
import { HOMEPAGE_CACHE_TAG } from "@/lib/content/homepage-data";
import { PRODUCTS_CACHE_TAG, productCacheTag } from "@/lib/content/product-data";

/** After a sale or a released hold (docs/plans/cart-checkout.md §7 "Revalidation"): the product
 * pages, their related lists and the homepage tiles show availability. The product's own data is
 * expired outright (`{ expire: 0 }`, the next PDP request reads fresh stock, as `revalidatePath`
 * did while the page was ISR); the shared lists may serve stale once while they refresh. Best-
 * effort: logged, never thrown, because the payment is already recorded. Only from a route handler
 * or a server action (the installed Next docs: revalidation is not allowed during render). */
export function revalidateProductPages(productSlugs: readonly string[], context: { orderNo: string | null }): void {
  if (productSlugs.length === 0) return;
  try {
    for (const slug of productSlugs) revalidateTag(productCacheTag(slug), { expire: 0 });
    revalidateTag(PRODUCTS_CACHE_TAG, "max");
    revalidateTag(HOMEPAGE_CACHE_TAG, "max");
  } catch (error) {
    console.error("[payments] product pages were not revalidated", { orderNo: context.orderNo, error: error instanceof Error ? error.name : typeof error });
  }
}
