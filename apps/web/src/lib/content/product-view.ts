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

  if (product.sizeMode === "all_size") {
    allsizeAvailableByColor = {};
    for (const variant of product.variants) {
      if (variant.size === "ALLSIZE") allsizeAvailableByColor[variant.fabricColorId] = variant.available;
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
      const availableBySize = new Map(variants.map((variant) => [variant.size, variant.available]));
      sizeOptionsByColor[color.id] = CUTTING_SIZES.map((size) => ({
        size,
        // A size with no variant row at all for this colour (never cut in this colour) reads the
        // same as "habis" — unavailable, never a crash, never treated as in-stock by omission.
        available: availableBySize.get(size) ?? false,
      }));
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
  };
}

/** A colour's own images first (sortOrder), then the product's general images — so a colour with
 * no colour-specific photos yet still shows the product's general shots instead of an empty
 * gallery. Falls back to EVERY general image for an unknown/null `colorId` (e.g. a tile that
 * doesn't pin a colour). */
export function getGalleryForColor(view: ProductView, colorId: string | null): ProductGalleryImage[] {
  const colorImages = colorId ? (view.imagesByColor[colorId] ?? []) : [];
  const gallery = [...colorImages, ...view.generalImages];
  return gallery.length > 0 ? gallery : view.generalImages;
}

/** Resolves the `?color=` query param against the product's actual colours — an unknown/stale
 * value (a colour that was deactivated after the link was shared, or a typo'd id) falls back to
 * `defaultColorId`, never renders a blank/broken selection. */
export function resolveSelectedColorId(view: ProductView, requestedColorId: string | null): string | null {
  if (requestedColorId && view.colors.some((color) => color.id === requestedColorId)) return requestedColorId;
  return view.defaultColorId;
}
