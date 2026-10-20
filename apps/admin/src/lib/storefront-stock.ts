import "server-only";
import { eq, inArray } from "drizzle-orm";
import { goodsReceiptItems, orderItems, productionBatchItems, products, productVariants } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import { revalidateProductSlugs } from "@/lib/revalidate";

// Storefront availability (PDP sizes, SOLD OUT, tile label) is derived from stock_movements and
// cached in apps/web for up to an hour, so every admin action that changes SELLABLE finished-goods
// stock must tell apps/web to refresh the affected product pages and the homepage. Same secret
// flow as product saves (lib/revalidate.ts). Defect movements, accessory/fabric purchases, "Tutup
// batch" and the shipped/completed order transitions never change sellable stock: no call there.

/** Resolves SKUs to their product slugs (deduplicated) and revalidates those pages + the homepage
 * in one batched call. `skus` may be a function (e.g. `() => skusForOrder(id)`) so that looking
 * the SKUs up is inside the same guard. NEVER throws: the admin action that just committed must
 * not fail because the storefront could not be reached or a lookup failed. `ok: false` means the
 * storefront may be stale. */
export async function revalidateStorefrontForSkus(
  skus: readonly string[] | (() => Promise<readonly string[]>),
  db: Database = defaultDb,
): Promise<{ ok: boolean }> {
  try {
    const unique = [...new Set(typeof skus === "function" ? await skus() : skus)];
    if (unique.length === 0) return { ok: true };
    const rows = await db
      .select({ slug: products.slug })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.sku, unique));
    return await revalidateProductSlugs(rows.map((row) => row.slug));
  } catch (error) {
    console.error("revalidateStorefrontForSkus failed", error);
    return { ok: false };
  }
}

/** SKUs of the given production batch lines (the receive form posts line ids, not SKUs). */
export async function skusForBatchLines(lineIds: readonly string[], db: Database = defaultDb): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const rows = await db.select({ sku: productionBatchItems.sku }).from(productionBatchItems).where(inArray(productionBatchItems.id, [...lineIds]));
  return rows.map((row) => row.sku);
}

/** SKUs a production goods receipt (or its reversal) touched; `[]` for a purchase receipt. */
export async function skusForReceipt(receiptId: string, db: Database = defaultDb): Promise<string[]> {
  const rows = await db
    .select({ sku: productionBatchItems.sku })
    .from(goodsReceiptItems)
    .innerJoin(productionBatchItems, eq(productionBatchItems.id, goodsReceiptItems.productionBatchItemId))
    .where(eq(goodsReceiptItems.goodsReceiptId, receiptId));
  return rows.map((row) => row.sku);
}

/** SKUs of an order's items. */
export async function skusForOrder(orderId: string, db: Database = defaultDb): Promise<string[]> {
  const rows = await db.select({ sku: orderItems.sku }).from(orderItems).where(eq(orderItems.orderId, orderId));
  return rows.map((row) => row.sku);
}
