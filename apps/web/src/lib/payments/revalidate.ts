import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { HOMEPAGE_CACHE_TAG } from "@/lib/content/homepage-data";

/** After a sale or a released hold (docs/plans/cart-checkout.md §7 "Revalidation"): the ISR product
 * pages and the homepage tiles show availability. Best-effort: logged, never thrown, because the
 * payment is already recorded. Only from a route handler or a server action (the installed Next
 * docs: revalidatePath is not allowed during render). */
export function revalidateProductPages(productSlugs: readonly string[], context: { orderNo: string | null }): void {
  if (productSlugs.length === 0) return;
  try {
    for (const slug of productSlugs) revalidatePath(`/products/${slug}`);
    revalidateTag(HOMEPAGE_CACHE_TAG, "max");
  } catch (error) {
    console.error("[payments] product pages were not revalidated", { orderNo: context.orderNo, error: error instanceof Error ? error.name : typeof error });
  }
}
