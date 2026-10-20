import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "../client";
import {
  fabricColors,
  fabrics,
  infoPages,
  productImages,
  products,
  productVariants,
  sizeChartRows,
  stockMovements,
  storefrontHomepageSections,
  storeSettings,
} from "../schema";
import {
  CUTTING_SIZES,
  HOMEPAGE_SECTION_KEYS,
  type CuttingSize,
  type HomepageSectionKey,
  type InfoPageSlug,
  type Size,
  type SizeMode,
} from "../schema/constants";
import { qualifiedColumn } from "../sql-helpers";

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
  // This correlated subquery (comparing stock_movements.sku to this query's own
  // product_variants.sku) MUST use `qualifiedColumn()` for both sides, never bare
  // `${table.column}` interpolation — see that helper's doc comment (packages/db/src/sql-helpers.ts)
  // for the exact, confirmed drizzle-orm 0.45.3 bug this avoids: this query has no join (just a
  // single `.from(productVariants)`), which is precisely the condition under which drizzle
  // renders every interpolated column bare/unqualified, including ones belonging to a different
  // table referenced only inside this subquery — silently turning the intended correlation into
  // a self-comparison that sums every SKU's stock, not just this one's.
  const variants = await db
    .select({
      sku: productVariants.sku,
      fabricColorId: productVariants.fabricColorId,
      size: productVariants.size,
      available: sql<boolean>`coalesce((select sum(${qualifiedColumn(stockMovements, stockMovements.qty)}) from ${stockMovements} where ${qualifiedColumn(stockMovements, stockMovements.sku)} = ${qualifiedColumn(productVariants, productVariants.sku)}), 0) > 0`,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productRow.id), eq(productVariants.isActive, true)));

  const colorIds = Array.from(
    new Set<string>([
      ...variants.map((variant) => variant.fabricColorId),
      ...images.flatMap((image) => (image.fabricColorId ? [image.fabricColorId] : [])),
    ]),
  );
  // Ordered by creation — `fabric_colors` has no explicit display-order column, so insertion
  // order is the only deterministic "canonical order" available, and the PDP needs ONE (first
  // swatch = default-selected colour, matching the homepage grid tile's own "first colour" pick
  // in getStorefrontProductTiles below).
  const colors =
    colorIds.length === 0
      ? []
      : await db
          .select({ id: fabricColors.id, name: fabricColors.name, hex: fabricColors.hex })
          .from(fabricColors)
          .where(and(inArray(fabricColors.id, colorIds), eq(fabricColors.isActive, true)))
          .orderBy(fabricColors.createdAt);

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

export interface StorefrontProductTileRef {
  productId: string;
  /** `null` = the tile doesn't pin a specific colour ("semua warna") — the renderer shows the
   * product's first colour (canonical order, see `getStorefrontProductBySlug`'s own comment)
   * plus a total colour count, instead of one fixed name. */
  fabricColorId: string | null;
}

export interface StorefrontProductTile {
  productId: string;
  fabricColorId: string | null;
  name: string;
  slug: string;
  basePrice: number;
  /** The resolved colour name to show — the pinned colour's name, or (when `fabricColorId` is
   * null) the product's first colour's name. `null` only if the product has no colours at all. */
  colorName: string | null;
  /** Total distinct active colours the product has — only meaningful to show (" - N warna") when
   * `fabricColorId` is null; a pinned-colour tile never shows a count. */
  colorCount: number;
  image: StorefrontProductImage | null;
  /** `true` when NO active variant of the product, in any colour, has stock (`SUM(qty) > 0`, same
   * boolean-only definition as `StorefrontVariant.available`). Product-level on purpose: a tile
   * pinned to one colour still reads "sold out" only when the whole product is. */
  soldOut: boolean;
}

/** Resolves homepage tile references (hero's `ctaTarget`, product grid tiles, feature block's
 * `linkedProduct`) against the live, published product catalog. A ref whose product is missing,
 * inactive, or no longer published on the storefront is simply OMITTED from the result — never
 * throws, never includes a partial/broken entry (docs/plans/storefront-cms.md: "the renderer
 * must treat that as 'skip this tile', never a crash"). Callers map the input refs to the output
 * by `(productId, fabricColorId)` and drop whichever didn't come back.
 *
 * Same explicit-column-list, no-cost-data discipline as every other query in this module — only
 * `id`/`name`/`slug`/`basePrice` off `products`, nothing from `fabrics`/cost tables at all. */
export async function getStorefrontProductTiles(
  refs: StorefrontProductTileRef[],
  db: Database = defaultDb,
): Promise<StorefrontProductTile[]> {
  const productIds = Array.from(new Set(refs.map((ref) => ref.productId)));
  if (productIds.length === 0) return [];

  const productRows = await db
    .select({ id: products.id, name: products.name, slug: products.slug, basePrice: products.basePrice })
    .from(products)
    .where(and(inArray(products.id, productIds), eq(products.isActive, true), eq(products.isPublishedOnStorefront, true)));
  const productById = new Map(productRows.map((row) => [row.id, row]));
  if (productById.size === 0) return [];

  const resolvedProductIds = [...productById.keys()];

  const imageRows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      storageKey: productImages.storageKey,
      fabricColorId: productImages.fabricColorId,
      altText: productImages.altText,
      sortOrder: productImages.sortOrder,
      width: productImages.width,
      height: productImages.height,
    })
    .from(productImages)
    .where(inArray(productImages.productId, resolvedProductIds))
    .orderBy(productImages.productId, productImages.sortOrder);

  const imagesByProduct = new Map<string, typeof imageRows>();
  for (const image of imageRows) {
    const list = imagesByProduct.get(image.productId) ?? [];
    list.push(image);
    imagesByProduct.set(image.productId, list);
  }

  const variantColorRows = await db
    .select({ productId: productVariants.productId, fabricColorId: productVariants.fabricColorId })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, resolvedProductIds), eq(productVariants.isActive, true)));

  // Same qty-only SUM and `qualifiedColumn()` correlation as `getStorefrontProductBySlug`'s
  // `available` (see the long comment there for why the qualification is mandatory).
  const stockRows = await db
    .select({
      productId: productVariants.productId,
      inStock: sql<boolean>`coalesce((select sum(${qualifiedColumn(stockMovements, stockMovements.qty)}) from ${stockMovements} where ${qualifiedColumn(stockMovements, stockMovements.sku)} = ${qualifiedColumn(productVariants, productVariants.sku)}), 0) > 0`,
    })
    .from(productVariants)
    .where(and(inArray(productVariants.productId, resolvedProductIds), eq(productVariants.isActive, true)));
  const inStockProductIds = new Set(stockRows.filter((row) => row.inStock).map((row) => row.productId));

  const colorIdsByProduct = new Map<string, Set<string>>();
  for (const row of variantColorRows) {
    const set = colorIdsByProduct.get(row.productId) ?? new Set<string>();
    set.add(row.fabricColorId);
    colorIdsByProduct.set(row.productId, set);
  }
  for (const image of imageRows) {
    if (!image.fabricColorId) continue;
    const set = colorIdsByProduct.get(image.productId) ?? new Set<string>();
    set.add(image.fabricColorId);
    colorIdsByProduct.set(image.productId, set);
  }

  const allColorIds = Array.from(new Set([...colorIdsByProduct.values()].flatMap((set) => [...set])));
  const colorRows =
    allColorIds.length === 0
      ? []
      : await db
          .select({ id: fabricColors.id, name: fabricColors.name })
          .from(fabricColors)
          .where(and(inArray(fabricColors.id, allColorIds), eq(fabricColors.isActive, true)))
          .orderBy(fabricColors.createdAt);
  const colorNameById = new Map(colorRows.map((row) => [row.id, row.name]));

  // The first colour (canonical, creation order) per product — `colorRows` is already ordered by
  // createdAt, so the first row matching a product's colour-id set is its canonical first colour.
  const firstColorIdByProduct = new Map<string, string>();
  for (const [productId, idSet] of colorIdsByProduct) {
    const first = colorRows.find((row) => idSet.has(row.id));
    if (first) firstColorIdByProduct.set(productId, first.id);
  }

  const toStorefrontImage = (row: (typeof imageRows)[number]): StorefrontProductImage => ({
    id: row.id,
    storageKey: row.storageKey,
    fabricColorId: row.fabricColorId,
    altText: row.altText,
    sortOrder: row.sortOrder,
    width: row.width,
    height: row.height,
  });

  const tiles: StorefrontProductTile[] = [];
  for (const ref of refs) {
    const product = productById.get(ref.productId);
    if (!product) continue; // deleted/deactivated/unpublished since the tile was saved — skip

    const productImageRows = imagesByProduct.get(ref.productId) ?? [];
    const colorCount = colorIdsByProduct.get(ref.productId)?.size ?? 0;

    let image: StorefrontProductImage | null = null;
    let colorName: string | null = null;

    if (ref.fabricColorId) {
      const matched = productImageRows.find((row) => row.fabricColorId === ref.fabricColorId);
      image = matched ? toStorefrontImage(matched) : productImageRows[0] ? toStorefrontImage(productImageRows[0]) : null;
      colorName = colorNameById.get(ref.fabricColorId) ?? null;
    } else {
      // "Semua warna" (no colour pinned) — prefer a GENERAL image (fabricColorId null) so the
      // tile doesn't visually imply one specific colour while its own caption says otherwise.
      // Only falls back to whatever image happens to sort first when the product has no general
      // shot at all (every photo tagged to a colour).
      const generalImage = productImageRows.find((row) => row.fabricColorId === null);
      image = generalImage ? toStorefrontImage(generalImage) : productImageRows[0] ? toStorefrontImage(productImageRows[0]) : null;
      const firstColorId = firstColorIdByProduct.get(ref.productId) ?? null;
      colorName = firstColorId ? (colorNameById.get(firstColorId) ?? null) : null;
    }

    tiles.push({
      productId: product.id,
      fabricColorId: ref.fabricColorId,
      name: product.name,
      slug: product.slug,
      basePrice: product.basePrice,
      colorName,
      colorCount,
      image,
      soldOut: !inStockProductIds.has(product.id),
    });
  }
  return tiles;
}

/** Backs the PDP's "Lengkapi koleksimu" section — up to `limit` OTHER active, published
 * products, preferring ones that share `excludeSlug`'s own fabric (a reasonable "goes with"
 * signal for a boutique catalog with no separate category/collection model) and falling back to
 * the most recently added otherwise. Takes a slug, not a product id + fabric id, so apps/web
 * never needs to know `fabricId` exists at all — the one thing it already has at the PDP route is
 * the slug from the URL. Returns the SAME `StorefrontProductTile` shape `getStorefrontProductTiles`
 * does (the spec's "same tile component as the grid" requirement starts here, not just in
 * apps/web's markup) by delegating to it with unpinned (`fabricColorId: null`) refs — no
 * duplicated image/colour-resolution logic. Returns `[]` for an unknown/unpublished slug or when
 * there's simply nothing else published yet — the PDP renders however many related tiles it gets
 * (possibly zero), never pads or throws. */
// ---------- Info pages + store settings (docs/plans/storefront-cms.md Phase 2, session 8) ----------

export interface StorefrontInfoPage {
  slug: InfoPageSlug;
  title: string;
  /** Sanitized HTML — the CALLER (apps/web's info-page route) must still sanitize again at render
   * time with @ammari/content-sanitize's sanitizeInfoPageHtml immediately before
   * `dangerouslySetInnerHTML`, same defense-in-depth posture the storefront description already
   * uses. Never the draft body — this function reads published_body only. */
  body: string;
}

/** Backs apps/web's 5 info-page routes. Returns `null` for a page that has never been published
 * (published_body/published_at are null until the first "Terbitkan") or an unknown slug — never
 * throws for either; the caller renders a "sedang disiapkan" state instead of a 500. */
export async function getPublishedInfoPage(slug: string, db: Database = defaultDb): Promise<StorefrontInfoPage | null> {
  const [row] = await db
    .select({ slug: infoPages.slug, title: infoPages.title, body: infoPages.publishedBody })
    .from(infoPages)
    .where(eq(infoPages.slug, slug))
    .limit(1);
  if (!row || row.body === null) return null;
  return { slug: row.slug as InfoPageSlug, title: row.title, body: row.body };
}

export interface StorefrontSettings {
  whatsappNumber: string | null;
  supportEmail: string | null;
  businessAddress: string | null;
  returnPolicySummary: string | null;
}

/** The one `store_settings` row (migration 0020 guarantees it always exists — see that
 * migration's own comment). Every field is nullable: the owner fills them in via the admin
 * settings form after this ships, and every web caller (footer, PDP WhatsApp CTA, PDP trust row)
 * must already treat `null` as "hide this," never a broken link/blank line — same contract
 * apps/web/src/lib/store-settings.ts's pre-existing env-var stand-in already uses. */
export async function getStoreSettings(db: Database = defaultDb): Promise<StorefrontSettings> {
  const [row] = await db
    .select({
      whatsappNumber: storeSettings.whatsappNumber,
      supportEmail: storeSettings.supportEmail,
      businessAddress: storeSettings.businessAddress,
      returnPolicySummary: storeSettings.returnPolicySummary,
    })
    .from(storeSettings)
    .limit(1);
  return row ?? { whatsappNumber: null, supportEmail: null, businessAddress: null, returnPolicySummary: null };
}

export async function getRelatedStorefrontProducts(
  params: { excludeSlug: string; limit: number },
  db: Database = defaultDb,
): Promise<StorefrontProductTile[]> {
  const [self] = await db
    .select({ id: products.id, fabricId: products.fabricId })
    .from(products)
    .where(eq(products.slug, params.excludeSlug))
    .limit(1);
  if (!self) return [];

  // `selfFabricId` is a plain captured string, not a drizzle Column — bound as an ordinary
  // query parameter when interpolated below, never a table-qualification concern (that risk is
  // specific to interpolating a SECOND TABLE's Column object, see qualifiedColumn()'s doc
  // comment). Read into its own variable so the `sql` fragment below doesn't textually resemble
  // that risky `${table.column} = ${table.column}` shape at all.
  const selfFabricId = self.fabricId;

  const candidates = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.isActive, true), eq(products.isPublishedOnStorefront, true), ne(products.id, self.id)))
    .orderBy(sql`(${products.fabricId} = ${selfFabricId}) desc`, sql`${products.createdAt} desc`)
    .limit(params.limit);

  return getStorefrontProductTiles(
    candidates.map((candidate) => ({ productId: candidate.id, fabricColorId: null })),
    db,
  );
}
