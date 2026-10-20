import "server-only";
import sharp from "sharp";
import { buildHeroOgImageKey, HERO_OG_IMAGE_HEIGHT, HERO_OG_IMAGE_WIDTH } from "@ammari/db/storefront-settings";
import { getStorageClient } from "@/lib/storage";
import { buildImageObjectKey } from "@/lib/products/image-keys";

// ---------- Hero Open Graph image (migration 0029) ----------
//
// The storefront's social preview for "/" and every non-product page is a 1200x630 JPEG cut from
// the PUBLISHED Hero image, generated here at "Terbitkan" time (publishHomepageSections) and
// stored next to the Hero's own WebP sizes in object storage (`<storageKey>/og.jpg`). JPEG, not
// the WebP the storefront renders: some link-preview crawlers (older WhatsApp/Facebook clients
// among them) still skip WebP og:images. Product pages keep their own OG image (the product's main
// photo) and never read this.

/** Crawlers start rejecting or skipping previews well above this; WhatsApp is the strictest. */
export const HERO_OG_IMAGE_MAX_BYTES = 300 * 1024;

/** Tried in order until the encoded JPEG fits HERO_OG_IMAGE_MAX_BYTES. A photo at 1200x630 lands
 * around 80-180 KB at the first step, the rest only matter for unusually noisy images. */
const JPEG_QUALITY_STEPS = [82, 74, 66, 58, 50] as const;

/** The source size read back from storage: the largest WebP the upload pipeline keeps (1600px on
 * the long edge), already EXIF-rotated and metadata-stripped by processUploadedImage. */
const SOURCE_SIZE = 1600;

/** Pure image transform: center-crops (`fit: cover`, same framing as the storefront Hero's own
 * `object-cover` rendering) to exactly 1200x630 and encodes a progressive JPEG, stepping quality
 * down until it fits the byte budget. Transparency is flattened onto white (JPEG has no alpha). A
 * source smaller than 1200x630 is upscaled: the OG image must be exactly this size, and the
 * upload pipeline's own minimum (1200x600 desktop) means that only ever happens by a few pixels. */
export async function renderHeroOgJpeg(source: Buffer): Promise<Buffer> {
  const resized = await sharp(source)
    .resize({ width: HERO_OG_IMAGE_WIDTH, height: HERO_OG_IMAGE_HEIGHT, fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .toBuffer();

  const encode = (quality: number) => sharp(resized).jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
  let encoded = await encode(JPEG_QUALITY_STEPS[0]);
  for (const quality of JPEG_QUALITY_STEPS.slice(1)) {
    if (encoded.length <= HERO_OG_IMAGE_MAX_BYTES) return encoded;
    encoded = await encode(quality);
  }
  if (encoded.length <= HERO_OG_IMAGE_MAX_BYTES) return encoded;
  // The lowest step is still returned rather than failing the publish: an oversized preview is
  // better than none, and logged so it's visible.
  console.error(`hero-og-image: JPEG still ${encoded.length} bytes at the lowest quality step`);
  return encoded;
}

/** The Hero image storage key out of a hero section's (draft or published) content JSON, or null
 * when the Hero has no image. Content was validated by heroContentSchema when it was SAVED, but
 * publish never re-validates shape (see publishHomepageSections), so this reads defensively. */
export function heroImageStorageKeyOf(content: unknown): string | null {
  const image = (content as { image?: { storageKey?: unknown } | null } | null)?.image;
  return typeof image?.storageKey === "string" && image.storageKey.length > 0 ? image.storageKey : null;
}

/** Reads the Hero image back from storage, renders the OG JPEG and stores it. Returns the OG
 * object key, or null when it could not be produced. Never throws: a failure here must never fail
 * the homepage publish itself (the storefront then falls back to its static placeholder OG
 * image), so it's logged loudly instead, same posture as lib/revalidate.ts.
 *
 * The key is deterministic per Hero image, so a retry after an earlier failure can re-put the same
 * key. That stays safe under the storage client's immutable Cache-Control: the bytes are a pure
 * function of the same immutable source image. */
export async function generateHeroOgImage(heroStorageKey: string): Promise<string | null> {
  const ogKey = buildHeroOgImageKey(heroStorageKey);
  try {
    const storage = getStorageClient();
    const source = await storage.get(buildImageObjectKey(heroStorageKey, SOURCE_SIZE));
    if (!source) {
      console.error(`hero-og-image: source image ${heroStorageKey} (${SOURCE_SIZE}px) not found in storage, no OG image generated`);
      return null;
    }
    await storage.put(ogKey, await renderHeroOgJpeg(source), "image/jpeg");
    return ogKey;
  } catch (error) {
    console.error(`hero-og-image: failed to generate the OG image for ${heroStorageKey}`, error);
    return null;
  }
}
