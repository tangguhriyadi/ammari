import type { HomepageSectionKey } from "@ammari/db/schema";

/** Stored on a homepage section's `*_content.image.storageKey` (or `.mobileStorageKey`) — the
 * directory-like prefix, WITHOUT a size or extension, mirroring
 * apps/admin/src/lib/products/image-keys.ts's `buildImageStorageKey` exactly (same shape, just
 * rooted under `content/{sectionKey}/` instead of `products/{productId}/` — docs/plans/
 * storefront-cms.md's "Image uploads" section). The actual per-size object key is built by that
 * same module's `buildImageObjectKey`, reused unchanged — it's generic over any storage key
 * prefix, not products-specific. */
export function buildContentImageStorageKey(params: { keyPrefix: string; sectionKey: HomepageSectionKey; imageId: string }): string {
  return `${params.keyPrefix}content/${params.sectionKey}/${params.imageId}`;
}
