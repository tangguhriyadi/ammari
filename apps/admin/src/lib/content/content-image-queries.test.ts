import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import { ActionError } from "@/lib/errors";
import { buildImageObjectKey } from "@/lib/products/image-keys";
import {
  cleanupOrphanedContentImages,
  deleteContentImageObjects,
  uploadContentImage,
} from "./content-image-queries";

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 150, b: 180 } } })
    .jpeg()
    .toBuffer();
}

/** Same GPS-stand-in approach image-processing.test.ts already uses — sharp's typed `withExif`
 * API only writes simple IFD0..3 string tags, not a structured binary GPS IFD, so a Copyright
 * tag embedding GPS-looking text is the closest reproducible stand-in for "an image with
 * location metadata." The behavior under test (ALL metadata stripped, because
 * processUploadedImage never calls `.withMetadata()`) covers a true GPS IFD tag identically. */
async function jpegWithGpsLikeExif(width: number, height: number): Promise<Buffer> {
  const base = await jpeg(width, height);
  return sharp(base).withMetadata({ exif: { IFD0: { Copyright: "GPS:-6.9147,107.6098" } } }).toBuffer();
}

/** First bytes of an HEIC/HEIF container (ISOBMFF "ftyp" box) — none of sniffImageContentType's
 * JPEG/PNG/WebP magic-byte checks match this, so it's rejected the same way a renamed non-image
 * file is (image-processing.test.ts). Stands in for "an unconverted HEIC photo from an iPhone,
 * picked via the Files app rather than the Photo Library (which Safari would otherwise
 * transcode to JPEG before it ever reaches this server)." */
function heicLikeBuffer(): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write("ftyp", 4, "ascii");
  box.write("heic", 8, "ascii");
  return box;
}

let memoryStorage: InMemoryStorageClient;

beforeEach(() => {
  memoryStorage = new InMemoryStorageClient();
  __setStorageClientForTests(memoryStorage);
});

afterEach(() => {
  __setStorageClientForTests(undefined);
});

describe("uploadContentImage", () => {
  test("uploads 3 WebP sizes under a fresh storage key", async () => {
    const result = await uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1600, 900) });

    expect(result.width).toBe(1600);
    expect(result.height).toBe(900);
    expect(result.storageKey).toContain("content/hero/");
    const keys = [...memoryStorage.objects.keys()].filter((key) => key.startsWith(result.storageKey));
    expect(new Set(keys)).toEqual(
      new Set([`${result.storageKey}/400.webp`, `${result.storageKey}/800.webp`, `${result.storageKey}/1600.webp`]),
    );
  });

  test("strips GPS/EXIF metadata from every stored size", async () => {
    const result = await uploadContentImage({
      sectionKey: "hero",
      variant: "desktop",
      fileBuffer: await jpegWithGpsLikeExif(1600, 900),
    });

    for (const size of [400, 800, 1600] as const) {
      const object = memoryStorage.objects.get(buildImageObjectKey(result.storageKey, size));
      expect(object).toBeDefined();
      const meta = await sharp(object!.body).metadata();
      expect(meta.exif).toBeUndefined();
    }
  });

  test("rejects a HEIC-like file with a clear error, without writing any object", async () => {
    await expect(
      uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: heicLikeBuffer() }),
    ).rejects.toThrow(/JPEG, PNG, atau WebP/);
    expect(memoryStorage.objects.size).toBe(0);
  });

  test("rejects a desktop image smaller than the minimum full-bleed dimensions", async () => {
    await expect(
      uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1000, 500) }),
    ).rejects.toThrow(ActionError);
    expect(memoryStorage.objects.size).toBe(0);
  });

  test("accepts a desktop image exactly at the minimum dimensions", async () => {
    await expect(
      uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1200, 600) }),
    ).resolves.toMatchObject({ width: 1200, height: 600 });
  });

  test("rejects a mobile crop smaller than ITS minimum (different from the desktop minimum)", async () => {
    // 1000x500 passes nothing — too small either way — so use a size that would be VALID as a
    // desktop image but is still too small for the taller mobile-crop minimum, proving the two
    // variants are checked against genuinely different thresholds.
    await expect(
      uploadContentImage({ sectionKey: "hero", variant: "mobile", fileBuffer: await jpeg(1200, 600) }),
    ).rejects.toThrow(ActionError);
  });

  test("accepts a mobile crop at its own (portrait) minimum", async () => {
    await expect(
      uploadContentImage({ sectionKey: "hero", variant: "mobile", fileBuffer: await jpeg(750, 1000) }),
    ).resolves.toMatchObject({ width: 750, height: 1000 });
  });

  test("two uploads for the same section get different storage keys (never overwrite)", async () => {
    const first = await uploadContentImage({ sectionKey: "feature_block", variant: "desktop", fileBuffer: await jpeg(1600, 900) });
    const second = await uploadContentImage({ sectionKey: "feature_block", variant: "desktop", fileBuffer: await jpeg(1600, 900) });
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(memoryStorage.objects.size).toBe(6);
  });
});

describe("deleteContentImageObjects / cleanupOrphanedContentImages", () => {
  test("deleteContentImageObjects removes every size object under one storage key", async () => {
    const { storageKey } = await uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1600, 900) });
    await deleteContentImageObjects(storageKey);
    const remaining = [...memoryStorage.objects.keys()].filter((key) => key.startsWith(storageKey));
    expect(remaining).toHaveLength(0);
  });

  test("cleanupOrphanedContentImages deletes every (de-duplicated) key given", async () => {
    const a = await uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1600, 900) });
    const b = await uploadContentImage({ sectionKey: "hero", variant: "desktop", fileBuffer: await jpeg(1600, 900) });

    await cleanupOrphanedContentImages([a.storageKey, a.storageKey, b.storageKey]);

    expect(memoryStorage.objects.size).toBe(0);
  });

  test("cleanupOrphanedContentImages never throws even if a delete fails", async () => {
    const failing = new InMemoryStorageClient();
    failing.delete = async () => {
      throw new Error("simulated storage outage");
    };
    __setStorageClientForTests(failing);

    await expect(cleanupOrphanedContentImages(["content/hero/does-not-matter"])).resolves.toBeUndefined();
  });
});
