import type { ImageSize } from "./image-processing";

/** Stored on product_images.storage_key — the directory-like prefix, WITHOUT a size or
 * extension. Lets one row represent all 3 WebP sizes (buildImageObjectKey below appends the
 * size) instead of needing 3 separate key columns. */
export function buildImageStorageKey(params: { keyPrefix: string; productId: string; imageId: string }): string {
  return `${params.keyPrefix}products/${params.productId}/${params.imageId}`;
}

/** The actual object key put/deleted in the bucket for one size of one image. */
export function buildImageObjectKey(storageKey: string, size: ImageSize): string {
  return `${storageKey}/${size}.webp`;
}
