import { CUTTING_SIZES, type CuttingSize } from "@ammari/db/schema";
import { PRODUCT_HIGHLIGHT_KEYS, PRODUCT_HIGHLIGHT_LABELS, type ProductHighlightKey } from "@ammari/db/highlights";
import type { StorefrontProduct, StorefrontSizeChartRow } from "@ammari/db/storefront";

// Pure data-mapping from the storefront read layer's `StorefrontProduct` shape into a
// render-ready view model for `/products/[slug]` — no DB, no JSX, isomorphic (used by both the
// server-rendered initial view and the client-side colour/size picker). Kept separate from the
// page component so it's unit-testable without a database (see product-view.test.ts).

export interface ProductGalleryImage {
  id: string;
  storageKey: string;
  altText: string;
}

export interface ProductColorOption {
  id: string;
  name: string;
  hex: string | null;
}

export interface ProductSizeOption {
  size: CuttingSize;
  /** What "Tambah ke keranjang" adds. A SKU is a public product code, never stock or cost. */
  sku: string;
  available: boolean;
}

export interface ProductHighlightView {
  key: ProductHighlightKey;
  label: string;
}

export interface ProductView {
  id: string;
  name: string;
  slug: string;
  basePrice: number;
  storefrontDescription: string | null;
  careInstructions: string | null;
  allsizeFitNote: string | null;
  sizeMode: StorefrontProduct["sizeMode"];
  colors: ProductColorOption[];
  /** First colour in canonical order — the colour pre-selected when a shopper lands on the PDP
   * with no `?color=` in the URL. `null` only if the product somehow has no colours at all. */
  defaultColorId: string | null;
  highlights: ProductHighlightView[];
  sizeChart: StorefrontSizeChartRow[] | null;
  /** Images tagged to one specific colour, keyed by `fabricColorId`, each already sorted by
   * `sortOrder`. */
  imagesByColor: Record<string, ProductGalleryImage[]>;
  /** General images (`fabricColorId: null`) — shown for every colour, appended after that
   * colour's own images (see `getGalleryForColor`). */
  generalImages: ProductGalleryImage[];
  /** `sizeMode: 'sized'` only — per-colour size availability, in `CUTTING_SIZES` canonical order.
   * `null` for an `all_size` product (nothing to tabulate; see `allsizeAvailableByColor`). */
  sizeOptionsByColor: Record<string, ProductSizeOption[]> | null;
  /** `sizeMode: 'all_size'` only — each colour's single ALLSIZE variant availability, keyed by
   * `fabricColorId`. `null` for a `sized` product. */
  allsizeAvailableByColor: Record<string, boolean> | null;
  /** `sizeMode: 'all_size'` only — each colour's single ALLSIZE variant SKU, keyed by
   * `fabricColorId`. `null` for a `sized` product. */
  allsizeSkuByColor: Record<string, string> | null;
  /** `true` when no active variant of any colour has stock. */
  soldOut: boolean;
}

function toGalleryImage(image: { id: string; storageKey: string; altText: string | null }, fallbackAlt: string): ProductGalleryImage {
  return { id: image.id, storageKey: image.storageKey, altText: image.altText ?? fallbackAlt };
}

export function buildProductView(product: StorefrontProduct): ProductView {
  const imagesByColor: Record<string, ProductGalleryImage[]> = {};
  const generalImages: ProductGalleryImage[] = [];
  for (const image of [...product.images].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const view = toGalleryImage(image, product.name);
    if (image.fabricColorId) {
      (imagesByColor[image.fabricColorId] ??= []).push(view);
    } else {
      generalImages.push(view);
    }
  }

  const colors: ProductColorOption[] = product.colors.map((color) => ({ id: color.id, name: color.name, hex: color.hex }));

  let sizeOptionsByColor: Record<string, ProductSizeOption[]> | null = null;
  let allsizeAvailableByColor: Record<string, boolean> | null = null;
  let allsizeSkuByColor: Record<string, string> | null = null;

  if (product.sizeMode === "all_size") {
    allsizeAvailableByColor = {};
    allsizeSkuByColor = {};
    for (const variant of product.variants) {
      if (variant.size !== "ALLSIZE") continue;
      allsizeAvailableByColor[variant.fabricColorId] = variant.available;
      allsizeSkuByColor[variant.fabricColorId] = variant.sku;
    }
  } else {
    sizeOptionsByColor = {};
    const variantsByColor = new Map<string, typeof product.variants>();
    for (const variant of product.variants) {
      const list = variantsByColor.get(variant.fabricColorId) ?? [];
      list.push(variant);
      variantsByColor.set(variant.fabricColorId, list);
    }
    for (const color of colors) {
      const variants = variantsByColor.get(color.id) ?? [];
      const variantBySize = new Map(variants.map((variant) => [variant.size, variant]));
      // Only sizes this colour has an ACTIVE variant for (`product.variants` is active-only) are
      // offered at all: a size never cut in this colour is absent, not shown as "habis". Of those,
      // `available` is stock > 0. Order: the size chart's own row order, then any remaining size
      // in canonical order (a variant whose size has no chart row must still be offered).
      const chartSizes = (product.sizeChart ?? []).map((row) => row.size);
      const orderedSizes = [...chartSizes, ...CUTTING_SIZES.filter((size) => !chartSizes.includes(size))];
      sizeOptionsByColor[color.id] = orderedSizes.flatMap((size) => {
        const variant = variantBySize.get(size);
        return variant ? [{ size: size as CuttingSize, sku: variant.sku, available: variant.available }] : [];
      });
    }
  }

  const highlights: ProductHighlightView[] = PRODUCT_HIGHLIGHT_KEYS.filter((key) => product.highlights.includes(key)).map((key) => ({
    key,
    label: PRODUCT_HIGHLIGHT_LABELS[key],
  }));

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    basePrice: product.basePrice,
    storefrontDescription: product.storefrontDescription,
    careInstructions: product.careInstructions,
    allsizeFitNote: product.allsizeFitNote,
    sizeMode: product.sizeMode,
    colors,
    defaultColorId: colors[0]?.id ?? null,
    highlights,
    sizeChart: product.sizeChart,
    imagesByColor,
    generalImages,
    sizeOptionsByColor,
    allsizeAvailableByColor,
    allsizeSkuByColor,
    soldOut: !product.variants.some((variant) => variant.available),
  };
}

/** The first colour (canonical order, then any other tagged colour) that has photos of its own. */
function firstColorWithImages(view: ProductView): ProductGalleryImage[] {
  for (const color of view.colors) {
    const images = view.imagesByColor[color.id];
    if (images && images.length > 0) return images;
  }
  return Object.values(view.imagesByColor).find((images) => images.length > 0) ?? [];
}

/** The gallery for the selected colour, with a fallback chain so it's never empty while the
 * product has ANY photo (a colour's variants can be active before its own photo exists):
 *   1. the colour's own images (sortOrder), then the product's general images;
 *   2. neither exists: the first other colour's images (canonical colour order);
 *   3. the product has no photo at all: `[]`, and the caller renders the static placeholder.
 * An unknown/null `colorId` (e.g. a tile that doesn't pin a colour) starts from step 1 with just
 * the general images. */
export function getGalleryForColor(view: ProductView, colorId: string | null): ProductGalleryImage[] {
  const colorImages = colorId ? (view.imagesByColor[colorId] ?? []) : [];
  const gallery = [...colorImages, ...view.generalImages];
  return gallery.length > 0 ? gallery : firstColorWithImages(view);
}

/** The product's one representative photo (OG image, JSON-LD): the first general image, else the
 * first colour's first image. `null` when the product has no photo at all, so the caller uses the
 * static placeholder instead. */
export function getPrimaryImage(view: ProductView): ProductGalleryImage | null {
  return view.generalImages[0] ?? firstColorWithImages(view)[0] ?? null;
}

/** Resolves the `?color=` query param against the product's actual colours — an unknown/stale
 * value (a colour that was deactivated after the link was shared, or a typo'd id) falls back to
 * `defaultColorId`, never renders a blank/broken selection. */
export function resolveSelectedColorId(view: ProductView, requestedColorId: string | null): string | null {
  if (requestedColorId && view.colors.some((color) => color.id === requestedColorId)) return requestedColorId;
  return view.defaultColorId;
}
