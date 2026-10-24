import "server-only";
import { eq, ilike, or, sql } from "drizzle-orm";
import { fabricColors, products, productVariants, SIZES, type Size } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

// "Cocokkan ke varian" (docs/plans/marketplace-import.md §8.1): a search over admin variants by
// product name or code, colour, or SKU. Names from the marketplace file are never searched for
// automatically (matching is by SKU only); a person types what they are looking for.

export const MATCH_SEARCH_LIMIT = 20;

export interface MatchVariantOption {
  sku: string;
  productName: string;
  colorName: string;
  size: Size;
  /** The variant and its product are both active. Active ones are listed first. */
  isActive: boolean;
}

const activeSql = sql<boolean>`(${productVariants.isActive} and ${products.isActive})`;

export async function searchMatchVariants(rawQuery: string, db: Database = defaultDb): Promise<MatchVariantOption[]> {
  const q = rawQuery.trim().slice(0, 100);
  if (q.length < 2) return [];
  // ilike's own wildcards in the typed text match literally.
  const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return db
    .select({ sku: productVariants.sku, productName: products.name, colorName: fabricColors.name, size: productVariants.size, isActive: activeSql })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(or(ilike(products.name, pattern), ilike(products.code, pattern), ilike(productVariants.sku, pattern), ilike(fabricColors.name, pattern)))
    // Sizes in wearing order, as on Daftar SKU.
    .orderBy(sql`${activeSql} desc`, products.name, fabricColors.name, sql`array_position(array[${sql.join(SIZES.map((size) => sql`${size}`), sql`, `)}]::text[], ${productVariants.size})`, productVariants.sku)
    .limit(MATCH_SEARCH_LIMIT);
}
