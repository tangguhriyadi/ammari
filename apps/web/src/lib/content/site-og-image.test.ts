import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getCachedPublishedHeroOgImageMock } = vi.hoisted(() => ({ getCachedPublishedHeroOgImageMock: vi.fn() }));
vi.mock("./homepage-data", () => ({ getCachedPublishedHeroOgImage: getCachedPublishedHeroOgImageMock }));

const { getSiteOgImage, siteOgImageMetadata } = await import("./site-og-image");

describe("getSiteOgImage", () => {
  const saved = { storage: process.env.STORAGE_PUBLIC_BASE_URL, origin: process.env.BETTER_AUTH_URL };

  beforeEach(() => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://img.ammari.my.id/";
    process.env.BETTER_AUTH_URL = "https://ammari.my.id";
    getCachedPublishedHeroOgImageMock.mockReset();
  });

  afterEach(() => {
    process.env.STORAGE_PUBLIC_BASE_URL = saved.storage;
    process.env.BETTER_AUTH_URL = saved.origin;
    vi.restoreAllMocks();
  });

  test("the published Hero's OG JPEG, as an absolute URL on the public image domain", async () => {
    getCachedPublishedHeroOgImageMock.mockResolvedValue({ key: "content/hero/abc/og.jpg", altText: "Gamis sage" });
    expect(await getSiteOgImage()).toEqual({ url: "https://img.ammari.my.id/content/hero/abc/og.jpg", width: 1200, height: 630, alt: "Gamis sage" });
  });

  test("falls back to the static placeholder when no Hero OG image is published", async () => {
    getCachedPublishedHeroOgImageMock.mockResolvedValue(null);
    expect(await getSiteOgImage()).toEqual({ url: "https://ammari.my.id/images/product-placeholder-og.jpg", width: 1200, height: 630, alt: "Ammari" });
  });

  test("falls back to the placeholder (never throws) when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getCachedPublishedHeroOgImageMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await getSiteOgImage()).url).toBe("https://ammari.my.id/images/product-placeholder-og.jpg");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("siteOgImageMetadata", () => {
  test("sizes, alt and type on the image; twitter names only the card, never its own image", () => {
    const metadata = siteOgImageMetadata({ url: "https://img/og.jpg", width: 1200, height: 630, alt: "Ammari" });
    expect(metadata).toEqual({
      images: [{ url: "https://img/og.jpg", width: 1200, height: 630, alt: "Ammari", type: "image/jpeg" }],
      twitter: { card: "summary_large_image" },
    });
  });
});
