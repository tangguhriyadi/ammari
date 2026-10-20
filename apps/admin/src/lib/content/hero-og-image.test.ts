import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests } from "@/lib/storage";
import { generateHeroOgImage, HERO_OG_IMAGE_MAX_BYTES, heroImageStorageKeyOf, renderHeroOgJpeg } from "./hero-og-image";

async function solid(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 105, g: 90, b: 90 } } }).webp().toBuffer();
}

/** Pseudo-random noise pixels (fixed-seed LCG, so every run is identical): the worst case for
 * JPEG size, to prove the byte budget holds. */
async function noise(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}

describe("renderHeroOgJpeg", () => {
  test.each([
    ["landscape 1600x900", 1600, 900],
    ["portrait 1067x1600", 1067, 1600],
    ["square 1600x1600", 1600, 1600],
  ])("%s becomes exactly a 1200x630 JPEG", async (_label, width, height) => {
    const output = await renderHeroOgJpeg(await solid(width, height));
    const metadata = await sharp(output).metadata();
    expect({ format: metadata.format, width: metadata.width, height: metadata.height }).toEqual({ format: "jpeg", width: 1200, height: 630 });
  });

  test("stays under the 300 KB budget even for a worst-case noisy image", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const output = await renderHeroOgJpeg(await noise(1600, 900));
    expect(output.length).toBeLessThanOrEqual(HERO_OG_IMAGE_MAX_BYTES);
  });

  test("flattens transparency onto white instead of black", async () => {
    const transparent = await sharp({ create: { width: 1600, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { data } = await sharp(await renderHeroOgJpeg(transparent)).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });
});

describe("heroImageStorageKeyOf", () => {
  test("reads the image storage key, or null when there is no usable image", () => {
    expect(heroImageStorageKeyOf({ image: { storageKey: "content/hero/a" } })).toBe("content/hero/a");
    expect(heroImageStorageKeyOf({ image: null })).toBeNull();
    expect(heroImageStorageKeyOf({})).toBeNull();
    expect(heroImageStorageKeyOf(null)).toBeNull();
    expect(heroImageStorageKeyOf({ image: { storageKey: "" } })).toBeNull();
  });
});

describe("generateHeroOgImage", () => {
  let storage: InMemoryStorageClient;

  beforeEach(() => {
    storage = new InMemoryStorageClient();
    __setStorageClientForTests(storage);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    __setStorageClientForTests(undefined);
    vi.restoreAllMocks();
  });

  test("renders from the stored 1600px WebP and puts <storageKey>/og.jpg as image/jpeg", async () => {
    await storage.put("content/hero/a/1600.webp", await solid(1600, 900), "image/webp");
    expect(await generateHeroOgImage("content/hero/a")).toBe("content/hero/a/og.jpg");
    expect(storage.objects.get("content/hero/a/og.jpg")?.contentType).toBe("image/jpeg");
  });

  test("returns null (never throws) when the source image is missing", async () => {
    expect(await generateHeroOgImage("content/hero/missing")).toBeNull();
    expect(storage.objects.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  test("returns null (never throws) when storage fails", async () => {
    await storage.put("content/hero/a/1600.webp", await solid(1600, 900), "image/webp");
    vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("S3 down"));
    expect(await generateHeroOgImage("content/hero/a")).toBeNull();
  });
});
