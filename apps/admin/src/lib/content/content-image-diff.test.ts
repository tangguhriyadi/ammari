import { describe, expect, test } from "vitest";
import { diffOrphanedContentImageKeys, extractContentImageKeys } from "./content-image-diff";

describe("extractContentImageKeys", () => {
  test("returns [] for the seeded empty default", () => {
    expect(extractContentImageKeys({})).toEqual([]);
  });

  test("returns [] for content with no image field (product_grid/why_ammari shape)", () => {
    expect(extractContentImageKeys({ title: "Grid", tiles: [] })).toEqual([]);
  });

  test("returns [] when image is null", () => {
    expect(extractContentImageKeys({ headline: "Hi", image: null })).toEqual([]);
  });

  test("returns the storage key for an image with no mobile crop", () => {
    expect(extractContentImageKeys({ image: { storageKey: "content/hero/a", altText: "x", width: 10, height: 10 } })).toEqual([
      "content/hero/a",
    ]);
  });

  test("returns BOTH the main and mobile storage keys when a mobile crop is set", () => {
    const keys = extractContentImageKeys({
      image: {
        storageKey: "content/hero/a",
        mobileStorageKey: "content/hero/b",
        altText: "x",
        width: 10,
        height: 10,
        mobileWidth: 5,
        mobileHeight: 5,
      },
    });
    expect(keys).toEqual(["content/hero/a", "content/hero/b"]);
  });

  test("is tolerant of malformed/unexpected shapes", () => {
    expect(extractContentImageKeys(null)).toEqual([]);
    expect(extractContentImageKeys(undefined)).toEqual([]);
    expect(extractContentImageKeys("not an object")).toEqual([]);
    expect(extractContentImageKeys({ image: "not an object" })).toEqual([]);
    expect(extractContentImageKeys({ image: { storageKey: 123 } })).toEqual([]);
  });
});

describe("diffOrphanedContentImageKeys", () => {
  function withImage(storageKey: string) {
    return { image: { storageKey, altText: "x", width: 10, height: 10 } };
  }

  test("an image replaced in the draft, with no published version yet, becomes orphaned", () => {
    const before = withImage("content/hero/old");
    const newDraft = withImage("content/hero/new");
    expect(diffOrphanedContentImageKeys(before, newDraft, {})).toEqual(["content/hero/old"]);
  });

  test("an image replaced in the draft is NOT orphaned while still referenced by published", () => {
    const before = withImage("content/hero/old");
    const newDraft = withImage("content/hero/new");
    const published = withImage("content/hero/old");
    expect(diffOrphanedContentImageKeys(before, newDraft, published)).toEqual([]);
  });

  test("publishing (old published -> new published = draft) orphans the old published image", () => {
    const oldPublished = withImage("content/hero/old");
    const newPublished = withImage("content/hero/new"); // == the draft being promoted
    expect(diffOrphanedContentImageKeys(oldPublished, newPublished)).toEqual(["content/hero/old"]);
  });

  test("discarding (old draft -> reset to published) orphans the old draft's own image", () => {
    const oldDraft = withImage("content/hero/unsaved");
    const resetContent = withImage("content/hero/published"); // draft resets to this
    expect(diffOrphanedContentImageKeys(oldDraft, resetContent)).toEqual(["content/hero/unsaved"]);
  });

  test("no change at all orphans nothing", () => {
    const content = withImage("content/hero/same");
    expect(diffOrphanedContentImageKeys(content, content)).toEqual([]);
  });

  test("removing the image entirely orphans the old one", () => {
    const before = withImage("content/hero/old");
    expect(diffOrphanedContentImageKeys(before, { image: null })).toEqual(["content/hero/old"]);
  });
});
