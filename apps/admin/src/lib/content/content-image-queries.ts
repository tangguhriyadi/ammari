import "server-only";
import { randomUUID } from "node:crypto";
import type { HomepageSectionKey } from "@ammari/db/schema";
import { getStorageClient, getStorageKeyPrefix } from "@/lib/storage";
import { buildImageObjectKey } from "@/lib/products/image-keys";
import { IMAGE_SIZES, logUploadTiming, processUploadedImage, type ImageSize } from "@/lib/products/image-processing";
import { ActionError } from "@/lib/errors";
import { buildContentImageStorageKey } from "./content-image-keys";

// ---------- Content image upload (docs/plans/storefront-cms.md, session 5) ----------
//
// Reuses the EXACT product-photo pipeline (processUploadedImage: magic-byte sniff, EXIF
// auto-rotate, strip-all-metadata, 3 WebP sizes; getStorageClient()) — only the storage key
// prefix differs (content-image-keys.ts's buildContentImageStorageKey, not products/image-keys's
// buildImageStorageKey). Unlike a product photo, a content image is never a DB row: the
// `ContentImage` JSON object embedded in a homepage section's `*_content` JSONB IS the record
// (see homepage-schemas.ts's contentImageSchema), so this module only ever touches object
// storage, never the database — orphan/reference-safety bookkeeping (deciding WHEN a storage key
// is no longer referenced by any draft/published content) lives in homepage.ts, which calls
// `deleteContentImageObjects` here only after its own DB transaction has committed, same
// "database state changes first, storage cleanup second" rule
// apps/admin/src/lib/products/image-queries.ts's deleteProductImage already follows.

export type ContentImageVariant = "desktop" | "mobile";

// Minimum dimensions for a full-bleed homepage image, enforced server-side (never just a client
// hint) — chosen so the image can actually fill a common desktop viewport (1280-1920px wide)
// without the existing pipeline's own 1600px max resize target ever upscaling it, while staying
// well below what would make an obviously-too-small graphic (a logo, an icon) look plausible as
// hero art. The mobile crop's minimum is portrait (taller than wide) — it exists specifically for
// a narrow viewport, where a wide desktop crop would need severe, awkward cropping instead.
export const MIN_CONTENT_IMAGE_DESKTOP_WIDTH = 1200;
export const MIN_CONTENT_IMAGE_DESKTOP_HEIGHT = 600;
export const MIN_CONTENT_IMAGE_MOBILE_WIDTH = 750;
export const MIN_CONTENT_IMAGE_MOBILE_HEIGHT = 1000;

function assertMinDimensions(variant: ContentImageVariant, width: number, height: number): void {
  const isMobile = variant === "mobile";
  const minWidth = isMobile ? MIN_CONTENT_IMAGE_MOBILE_WIDTH : MIN_CONTENT_IMAGE_DESKTOP_WIDTH;
  const minHeight = isMobile ? MIN_CONTENT_IMAGE_MOBILE_HEIGHT : MIN_CONTENT_IMAGE_DESKTOP_HEIGHT;
  if (width < minWidth || height < minHeight) {
    throw new ActionError(
      `Gambar terlalu kecil untuk ${isMobile ? "crop mobile" : "gambar ini"} — minimal ${minWidth}x${minHeight} piksel ` +
        `(gambar yang diunggah berukuran ${width}x${height} piksel).`,
    );
  }
}

/** Same URL a fresh upload's `previewUrl` would have — used by each section's page.tsx to build
 * a preview URL for an already-saved `ContentImage` loaded from draftContent, so the editor form
 * always has something to render on first load without re-deriving the URL client-side. */
export function buildContentImagePreviewUrl(storageKey: string): string {
  return getStorageClient().publicUrl(buildImageObjectKey(storageKey, 800));
}

export interface UploadedContentImage {
  storageKey: string;
  width: number;
  height: number;
  /** Server-computed public URL (the 800px size) — the client never builds a storage URL
   * itself, same split apps/admin/src/lib/products/image-queries.ts's buildImageUrls draws for
   * product photos. */
  previewUrl: string;
}

/** Processes + uploads one content image's 3 WebP sizes under a brand-new `imageId` — replacing
 * an image is always a NEW upload, never an overwrite of the old objects (docs/plans/
 * storefront-cms.md's "Image uploads": "replacing an image means uploading a new one (new
 * imageId, new objects in the bucket) and only then overwriting the old storageKey in the draft
 * JSON"). No DB access at all — the caller (a server action) embeds the returned `storageKey`
 * into the section's draft content on its own subsequent save. */
export async function uploadContentImage(input: {
  sectionKey: HomepageSectionKey;
  variant: ContentImageVariant;
  fileBuffer: Buffer;
}): Promise<UploadedContentImage> {
  const sharpStarted = performance.now();
  const processed = await processUploadedImage(input.fileBuffer);
  const sharpMs = performance.now() - sharpStarted;
  assertMinDimensions(input.variant, processed.width, processed.height);

  const storage = getStorageClient();
  const imageId = randomUUID();
  const storageKey = buildContentImageStorageKey({
    keyPrefix: getStorageKeyPrefix(),
    sectionKey: input.sectionKey,
    imageId,
  });

  const putSizes: ImageSize[] = [];
  const s3Started = performance.now();
  try {
    for (const size of IMAGE_SIZES) {
      await storage.put(buildImageObjectKey(storageKey, size), processed.sizes[size], "image/webp");
      putSizes.push(size);
    }
  } catch {
    await deleteContentImageObjects(storageKey, putSizes);
    throw new ActionError("Gagal mengunggah gambar ke penyimpanan. Coba lagi.");
  }
  logUploadTiming(`content image (${input.sectionKey}/${input.variant})`, {
    sharpMs,
    s3Ms: performance.now() - s3Started,
    inputBytes: input.fileBuffer.length,
    outputBytes: IMAGE_SIZES.reduce((sum, size) => sum + processed.sizes[size].length, 0),
  });

  return {
    storageKey,
    width: processed.width,
    height: processed.height,
    previewUrl: storage.publicUrl(buildImageObjectKey(storageKey, 800)),
  };
}

/** Best-effort delete of every size object under one content image's storage key — mirrors
 * apps/admin/src/lib/products/image-queries.ts's deleteObjectsLogged for the same reason: object
 * storage isn't transactional, so a failure here just leaves an orphan for a future sweep,
 * logged (never silently swallowed) rather than failing the caller's own save/publish/discard. */
export async function deleteContentImageObjects(
  storageKey: string,
  sizes: readonly ImageSize[] = IMAGE_SIZES,
): Promise<void> {
  const storage = getStorageClient();
  await Promise.allSettled(
    sizes.map(async (size) => {
      try {
        await storage.delete(buildImageObjectKey(storageKey, size));
      } catch (error) {
        console.error(`failed to delete content image storage object ${storageKey} size ${size}:`, error);
      }
    }),
  );
}

/** Deletes every (de-duplicated) storage key no longer referenced by any draft/published
 * content — see homepage.ts's diffing logic for how this list is computed. Never throws: each
 * key's deletion is independently best-effort via deleteContentImageObjects above. */
export async function cleanupOrphanedContentImages(storageKeys: readonly string[]): Promise<void> {
  const unique = [...new Set(storageKeys)];
  await Promise.allSettled(unique.map((key) => deleteContentImageObjects(key)));
}
