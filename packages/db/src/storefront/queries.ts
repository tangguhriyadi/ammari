import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../client";
import {
  fabricColors,
  fabrics,
  productImages,
  products,
  productVariants,
  sizeChartRows,
  storefrontHomepageSections,
} from "../schema";
import { CUTTING_SIZES, HOMEPAGE_SECTION_KEYS, type CuttingSize, type HomepageSectionKey, type Size, type SizeMode } from "../schema/constants";

// Replaces the old `getActiveProductBySlug` placeholder (deleted — it was a bare `.select()`,
// exactly the anti-pattern this module must not repeat).
//
// Every query in this module names its exact column list explicitly — NEVER a bare `.select()` —
// so a future column added to `products`/`fabrics`/`product_variants` (a cost field, say) does
// NOT silently appear in a storefront response just because it exists on the table.
// `products.description` (the admin's internal working note) is never in a column list here at
// all — not filtered out after the fact, never selected in the first place. See
// test/storefront-queries.test.ts's cost-leak denylist test and description-distinctness test,
// which assert this against the *serialized output*, not just by reading this file.
//
// Price is always `products.base_price` — this module never reads
// `product_variants.price_override_amount`, and never joins any cost-bearing table
// (`fabrics.price_amount`/`price_unit`, `cost_components`, `production_batch_costs`,
// `accessory_movements.value_amount`, `stock_movements.value_amount` as a VALUE — only as a qty
// sum for availability, below, `production_*`).

type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
type Database = typeof defaultDb | Tx;

function byCanonicalHomepageKey<T extends { key: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      HOMEPAGE_SECTION_KEYS.indexOf(a.key as HomepageSectionKey) -
      HOMEPAGE_SECTION_KEYS.indexOf(b.key as HomepageSectionKey),
  );
}

export interface HomepageSectionContent {
  key: HomepageSectionKey;
  isVisible: boolean;
  content: unknown;
}

/** The live storefront's homepage content — published columns ONLY, never the draft ones. A
 * section that has never been published comes back with `isVisible: false, content: null`
 * (`published_is_visible`/`published_content` are null until the first "Terbitkan" — see
 * schema/content.ts). Always returns exactly the 4 fixed section keys, in their one canonical
 * order (`HOMEPAGE_SECTION_KEYS`), regardless of row storage order. */
export async function getPublishedHomepageContent(db: Database = defaultDb): Promise<HomepageSectionContent[]> {
  const rows = await db
    .select({
      key: storefrontHomepageSections.key,
      isVisible: storefrontHomepageSections.publishedIsVisible,
      content: storefrontHomepageSections.publishedContent,
    })
    .from(storefrontHomepageSections);

  return byCanonicalHomepageKey(rows).map((row) => ({
    key: row.key as HomepageSectionKey,
    isVisible: row.isVisible ?? false,
    content: row.content ?? null,
  }));
}

/** The DRAFT homepage content — used only by the admin editor and the signed-token preview
 * route, never by a normal storefront request (a real visitor must never see unpublished
 * content). Draft columns are never null (every row always has a draft). */
export async function getDraftHomepageContent(db: Database = defaultDb): Promise<HomepageSectionContent[]> {
  const rows = await db
    .select({
      key: storefrontHomepageSections.key,
      isVisible: storefrontHomepageSections.draftIsVisible,
      content: storefrontHomepageSections.draftContent,
    })
    .from(storefrontHomepageSections);

  return byCanonicalHomepageKey(rows).map((row) => ({
    key: row.key as HomepageSectionKey,
    isVisible: row.isVisible,
    content: row.content,
  }));
}

export interface StorefrontProductImage {
  id: string;
  storageKey: string;
  fabricColorId: string | null;
  altText: string | null;
  sortOrder: number;
  width: number;
  height: number;
}

export interface StorefrontFabricColor {
  id: string;
  name: string;
  hex: string | null;
}

export interface StorefrontVariant {
  sku: string;
  fabricColorId: string;
  size: Size;
  /** Boolean only — never the raw quantity, and never any scarcity-style "only N left" signal
   * (firmly decided against, see the plan). `true` iff `SUM(stock_movements.qty)` for this SKU
   * is greater than 0. Only active variants are ever included here at all (filtered in the
   * query below) — a deactivated variant simply doesn't appear, rather than appearing with
   * `available: false`. */
  available: boolean;
}

export interface StorefrontSizeChartRow {
  size: Size;
  bustCm: number;
  lengthCm: number;
  sleeveLengthCm: number;
  heightRecommendationMinCm: number;
  heightRecommendationMaxCm: number;
}

export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  basePrice: number;
  storefrontDescription: string | null;
  highlights: string[];
  sizeMode: SizeMode;
  allsizeFitNote: string | null;
  careInstructions: string | null;
  images: StorefrontProductImage[];
  colors: StorefrontFabricColor[];
  variants: StorefrontVariant[];
  sizeChart: StorefrontSizeChartRow[] | null;
}

/** Backs `/products/[slug]` (apps/web). Returns `null` for an inactive product, a product not
 * (yet) published on the storefront, or a slug that doesn't exist — never throws for any of
 * those cases. */
export async function getStorefrontProductBySlug(slug: string, db: Database = defaultDb): Promise<StorefrontProduct | null> {
  const [productRow] = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      basePrice: products.basePrice,
      storefrontDescription: products.storefrontDescription,
      highlights: products.highlights,
      sizeMode: products.sizeMode,
      allsizeFitNote: products.allsizeFitNote,
      sizeChartId: products.sizeChartId,
      careInstructions: fabrics.careInstructions,
    })
    .from(products)
    .innerJoin(fabrics, eq(fabrics.id, products.fabricId))
    .where(and(eq(products.slug, slug), eq(products.isActive, true), eq(products.isPublishedOnStorefront, true)))
    .limit(1);

  if (!productRow) return null;

  const images = await db
    .select({
      id: productImages.id,
      storageKey: productImages.storageKey,
      fabricColorId: productImages.fabricColorId,
      altText: productImages.altText,
      sortOrder: productImages.sortOrder,
      width: productImages.width,
      height: productImages.height,
    })
    .from(productImages)
    .where(eq(productImages.productId, productRow.id))
    .orderBy(productImages.fabricColorId, productImages.sortOrder);

  // `available` is a boolean derived from a qty-only SUM — never the raw stock number, and
  // never any other column off stock_movements (value_amount stays untouched).
  //
  // The subquery's correlation is written with hardcoded, explicitly table-qualified
  // identifiers ("sm.sku"/"product_variants.sku"), NOT `${productVariants.sku}`-style column
  // interpolation inside the `sql` template: drizzle-orm 0.45.3 renders an interpolated Column
  // reference as a bare, unqualified identifier (just `"sku"`, never `"product_variants"."sku"`)
  // when it appears inside a raw `sql` fragment rather than its own query-builder call. Since
  // `stock_movements.sku` and `product_variants.sku` share the exact same column name, two bare
  // `"sku"` references inside this subquery's scope both resolve to `stock_movements.sku` (the
  // only "sku" column the subquery's own FROM clause can see) — Postgres accepts that silently
  // (`"sku" = "sku"` is always true), so the subquery sums EVERY row in stock_movements, not
  // just this one SKU's. Confirmed empirically against the real local Postgres by reproducing
  // apps/admin/src/lib/stock/queries.ts's own identical `${stockMovements.qty}`/
  // `${stockMovements.sku} = ${productVariants.sku}` pattern with two SKUs: it returned the
  // SAME (wrong, summed-over-both) stock figure for both — see this session's report for the
  // two admin call sites affected. `sm.sku`/`product_variants.sku` here are hardcoded SQL text,
  // never user input, same safety argument schema/columns.ts's `checkIn`/`checkArraySubset`
  // already give for their own `sql.raw` use.
  const variants = await db
    .select({
      sku: productVariants.sku,
      fabricColorId: productVariants.fabricColorId,
      size: productVariants.size,
      available: sql<boolean>`coalesce((select sum(sm.qty) from stock_movements sm where sm.sku = product_variants.sku), 0) > 0`,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productRow.id), eq(productVariants.isActive, true)));

  const colorIds = Array.from(
    new Set<string>([
      ...variants.map((variant) => variant.fabricColorId),
      ...images.flatMap((image) => (image.fabricColorId ? [image.fabricColorId] : [])),
    ]),
  );
  const colors =
    colorIds.length === 0
      ? []
      : await db
          .select({ id: fabricColors.id, name: fabricColors.name, hex: fabricColors.hex })
          .from(fabricColors)
          .where(and(inArray(fabricColors.id, colorIds), eq(fabricColors.isActive, true)));

  let sizeChart: StorefrontSizeChartRow[] | null = null;
  if (productRow.sizeChartId) {
    const rows = await db
      .select({
        size: sizeChartRows.size,
        bustCm: sizeChartRows.bustCm,
        lengthCm: sizeChartRows.lengthCm,
        sleeveLengthCm: sizeChartRows.sleeveLengthCm,
        heightRecommendationMinCm: sizeChartRows.heightRecommendationMinCm,
        heightRecommendationMaxCm: sizeChartRows.heightRecommendationMaxCm,
      })
      .from(sizeChartRows)
      .where(eq(sizeChartRows.sizeChartId, productRow.sizeChartId));
    sizeChart = [...rows].sort(
      (a, b) => CUTTING_SIZES.indexOf(a.size as CuttingSize) - CUTTING_SIZES.indexOf(b.size as CuttingSize),
    );
  }

  return {
    id: productRow.id,
    name: productRow.name,
    slug: productRow.slug,
    basePrice: productRow.basePrice,
    storefrontDescription: productRow.storefrontDescription,
    highlights: productRow.highlights,
    sizeMode: productRow.sizeMode,
    allsizeFitNote: productRow.allsizeFitNote,
    careInstructions: productRow.careInstructions,
    images,
    colors,
    variants,
    sizeChart,
  };
}
