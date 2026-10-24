import "server-only";
import { and, eq, ilike, not, or, sql, type SQL } from "drizzle-orm";
import { fabricColors, products, productVariants, SIZES, stockMovements, type Size } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import type { ActiveFilter } from "./queries";

// "Daftar SKU" (docs/plans/marketplace-import.md §11.1): every variant's SKU next to its product,
// colour, size, status and physical stock, for copying into Shopee/TikTok listings. The marketplace
// import matches by SKU only, so these SKUs are what the listings must carry.

/** A list to copy, so no pagination; this many rows at most (a few hundred exist). */
export const SKU_LIST_MAX_ROWS = 5_000;

export interface SkuListRow {
  sku: string;
  productName: string;
  colorName: string;
  size: Size;
  /** Sellable in admin: the variant AND its product are active. */
  isActive: boolean;
  /** Physical stock, the same sum the Stok page shows. */
  stockQty: number;
}

export interface SkuListFilters {
  q?: string;
  activeFilter?: ActiveFilter;
}

/** The page's and the CSV route's shared reading of `?q=` / `?status=`, so the download always
 * holds exactly the rows on screen. */
export function skuListFilters(params: { q?: string | null; status?: string | null }): SkuListFilters {
  const status = params.status;
  return {
    q: params.q?.trim().slice(0, 100) || undefined,
    activeFilter: status === "active" || status === "inactive" ? status : undefined,
  };
}

const activeSql = sql<boolean>`(${productVariants.isActive} and ${products.isActive})`;

export async function listSkus(filters: SkuListFilters, db: Database = defaultDb): Promise<{ rows: SkuListRow[]; truncated: boolean }> {
  const stockBySku = db
    .select({ sku: stockMovements.sku, qty: sql<number>`sum(${stockMovements.qty})::int`.as("qty") })
    .from(stockMovements)
    .groupBy(stockMovements.sku)
    .as("stock_by_sku");

  const q = filters.q?.trim();
  const conditions: (SQL | undefined)[] = [
    q ? or(ilike(products.name, `%${q}%`), ilike(products.code, `%${q}%`), ilike(productVariants.sku, `%${q}%`), ilike(fabricColors.name, `%${q}%`)) : undefined,
    filters.activeFilter === "active" ? activeSql : undefined,
    filters.activeFilter === "inactive" ? not(activeSql) : undefined,
  ];

  const rows = await db
    .select({
      sku: productVariants.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      isActive: activeSql,
      stockQty: sql<number>`coalesce(${stockBySku.qty}, 0)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(stockBySku, eq(stockBySku.sku, productVariants.sku))
    .where(and(...conditions.filter((condition) => condition !== undefined)))
    // Sizes in wearing order (XS..XL, then All Size), not alphabetically.
    .orderBy(products.name, fabricColors.name, sql`array_position(array[${sql.join(SIZES.map((size) => sql`${size}`), sql`, `)}]::text[], ${productVariants.size})`, productVariants.sku)
    .limit(SKU_LIST_MAX_ROWS + 1);

  return { rows: rows.slice(0, SKU_LIST_MAX_ROWS), truncated: rows.length > SKU_LIST_MAX_ROWS };
}

/** The header and rows of the CSV download and the "Salin tabel" copy, in one place. */
export function skuListTable(rows: readonly SkuListRow[], sizeLabel: (size: string) => string): (string | number)[][] {
  return [
    ["Produk", "Warna", "Ukuran", "SKU", "Status", "Stok"],
    ...rows.map((row) => [row.productName, row.colorName, sizeLabel(row.size), row.sku, row.isActive ? "Aktif" : "Nonaktif", row.stockQty]),
  ];
}
