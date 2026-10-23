// Mirrors apps/admin's own image pipeline exactly (apps/admin/src/lib/products/image-keys.ts /
// image-processing.ts) — apps/web never uploads, deletes, or holds S3 credentials (docs/plans/
// storefront-cms.md's "Image uploads" section), it only ever reads `storageKey` off the DB and
// builds a public URL by string concatenation, same shape `S3StorageClient.publicUrl()` returns
// (`${publicBaseUrl}/${key}`) — kept local rather than importing @ammari/storage, since this app
// never constructs a real storage client at all.
//
// Deliberately NOT a whole-file "server-only" module: `storageImageUrl` (which reads
// `process.env.STORAGE_PUBLIC_BASE_URL` directly) is for SERVER components only, but the PDP's
// colour/gallery picker (product-purchase-panel.tsx) is a CLIENT component that needs to build
// the same URLs as the shopper switches colours — and `STORAGE_PUBLIC_BASE_URL` is deliberately
// NOT a `NEXT_PUBLIC_` var (same "built once, deployed environment-neutral" reasoning
// lib/cart-flag.ts's own doc comment gives), so it's never inlined into the client bundle. The
// server resolves it ONCE (`getStoragePublicBaseUrl()`, called from a Server Component) and
// passes the plain string down as a prop; the client then uses `buildImageUrl` below, a pure
// function with no env access at all, to build URLs from that already-resolved base.

export const IMAGE_SIZES = [400, 800, 1600] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Server-only — reads `STORAGE_PUBLIC_BASE_URL` directly. Call from a Server Component only; a
 * Client Component that needs to build image URLs itself (the PDP's colour picker) receives the
 * resolved base as a plain string prop instead (see this module's own doc comment above). */
export function getStoragePublicBaseUrl(): string {
  const base = process.env.STORAGE_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      "STORAGE_PUBLIC_BASE_URL is not set — required to render any product/content image. " +
        "Fill it in apps/web/.env (see .env.example), matching apps/admin's own storage config.",
    );
  }
  return base.replace(/\/+$/, "");
}

/** Pure — no env access, safe to call from a Client Component. `storageKey` is the directory-like
 * prefix stored on `product_images`/a homepage section's `ContentImage`, WITHOUT a size or
 * extension (buildImageStorageKey/buildContentImageStorageKey in apps/admin); this appends the
 * one size suffix apps/admin's own `buildImageObjectKey` uses. */
export function buildImageUrl(base: string, storageKey: string, size: ImageSize = 1600): string {
  return `${base}/${storageKey}/${size}.webp`;
}

/** A `srcset` over the pre-generated sizes, for an `<img>` the browser picks the file for itself
 * (next/image can't: `images.unoptimized` makes it emit no srcset and drop a passed one, see
 * docs/plans/pdp-gallery.md §5). Pure, same as `buildImageUrl`. */
export function buildImageSrcSet(base: string, storageKey: string, sizes: readonly ImageSize[]): string {
  return sizes.map((size) => `${buildImageUrl(base, storageKey, size)} ${size}w`).join(", ");
}

/** Convenience for Server Components (the homepage sections, the PDP's own static metadata/
 * JSON-LD, the related-products tiles) — resolves the base URL AND builds the full URL in one
 * call. Never call this from a Client Component (see this module's own doc comment). */
export function storageImageUrl(storageKey: string, size: ImageSize = 1600): string {
  return buildImageUrl(getStoragePublicBaseUrl(), storageKey, size);
}
