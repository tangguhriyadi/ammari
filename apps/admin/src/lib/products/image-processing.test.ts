import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  IMAGE_SIZES,
  ImageValidationError,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  processUploadedImage,
  sniffImageContentType,
} from "./image-processing";

/** A plain solid-color JPEG at the given raw pixel size — no EXIF, no orientation tag. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 150, b: 180 } } })
    .jpeg()
    .toBuffer();
}

/** Same base image, but with an EXIF orientation tag (6 = rotate 90° CW to display correctly)
 * and an IFD0 tag standing in for camera/GPS-identifying metadata — sharp's typed `withExif`
 * API only writes simple IFD0..3 string tags, not a structured binary GPS IFD, so this is the
 * closest reproducible stand-in; the behavior under test (ALL metadata stripped by default
 * whenever `.withMetadata()` is never called — see sharp's own docs) covers true GPS tags too. */
async function makeJpegWithOrientationAndExif(width: number, height: number): Promise<Buffer> {
  const base = await makeJpeg(width, height);
  return sharp(base)
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "TestCam", Copyright: "GPS:-6.9,107.6" } } })
    .toBuffer();
}

describe("sniffImageContentType", () => {
  test("recognizes a JPEG by its magic bytes", async () => {
    expect(sniffImageContentType(await makeJpeg(10, 10))).toBe("image/jpeg");
  });

  test("recognizes a PNG by its magic bytes", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    expect(sniffImageContentType(png)).toBe("image/png");
  });

  test("recognizes a WebP by its magic bytes", async () => {
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).webp().toBuffer();
    expect(sniffImageContentType(webp)).toBe("image/webp");
  });

  test("rejects a renamed non-image file (e.g. a script with a .jpg extension)", () => {
    expect(sniffImageContentType(Buffer.from("#!/bin/sh\necho hi\n"))).toBeNull();
  });

  test("rejects an empty buffer", () => {
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("processUploadedImage", () => {
  test("rejects a file over 10 MB without touching sharp", async () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_FILE_SIZE_BYTES + 1);
    await expect(processUploadedImage(oversized)).rejects.toThrow(ImageValidationError);
  });

  test("rejects a non-image buffer", async () => {
    await expect(processUploadedImage(Buffer.from("not an image"))).rejects.toThrow(ImageValidationError);
  });

  test("rejects a corrupt JPEG (valid magic bytes, garbage body)", async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("garbage-not-really-a-jpeg")]);
    await expect(processUploadedImage(corrupt)).rejects.toThrow(ImageValidationError);
  });

  test("rejects an image whose dimensions exceed the pixel limit", async () => {
    // 9000x9000 = 81 megapixels, over the 40-megapixel limitInputPixels guard.
    const huge = await makeJpeg(9000, 9000);
    await expect(processUploadedImage(huge)).rejects.toThrow(ImageValidationError);
  }, 30_000);

  test("produces one WebP buffer per IMAGE_SIZES entry", async () => {
    const result = await processUploadedImage(await makeJpeg(2000, 1000));
    for (const size of IMAGE_SIZES) {
      expect(result.sizes[size]).toBeInstanceOf(Buffer);
      expect(sniffImageContentType(result.sizes[size])).toBe("image/webp");
    }
  });

  test("never upscales: an image smaller than a target size is capped at its own dimension", async () => {
    // 300px wide is already smaller than every entry in IMAGE_SIZES (400/800/1600).
    const result = await processUploadedImage(await makeJpeg(300, 200));
    for (const size of IMAGE_SIZES) {
      const meta = await sharp(result.sizes[size]).metadata();
      expect(meta.width).toBeLessThanOrEqual(300);
    }
  });

  test("auto-rotates from EXIF orientation, swapping recorded width/height accordingly", async () => {
    const result = await processUploadedImage(await makeJpegWithOrientationAndExif(200, 100));
    // orientation 6 = rotate 90° CW: the visually-correct image is now tall, not wide.
    expect(result.width).toBe(100);
    expect(result.height).toBe(200);
  });

  test("strips ALL metadata (EXIF tags and orientation) from every output size", async () => {
    const result = await processUploadedImage(await makeJpegWithOrientationAndExif(200, 100));
    for (const size of IMAGE_SIZES) {
      const meta = await sharp(result.sizes[size]).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
  });
});
