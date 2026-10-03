import { describe, expect, test } from "vitest";
import { buildImageObjectKey, buildImageStorageKey } from "./image-keys";

describe("buildImageStorageKey", () => {
  test("joins prefix, productId and imageId with no size/extension", () => {
    expect(buildImageStorageKey({ keyPrefix: "dev/", productId: "p1", imageId: "i1" })).toBe("dev/products/p1/i1");
  });

  test("works with an empty prefix (production — root of the bucket)", () => {
    expect(buildImageStorageKey({ keyPrefix: "", productId: "p1", imageId: "i1" })).toBe("products/p1/i1");
  });
});

describe("buildImageObjectKey", () => {
  test("appends '/{size}.webp' to the storage key", () => {
    expect(buildImageObjectKey("dev/products/p1/i1", 400)).toBe("dev/products/p1/i1/400.webp");
    expect(buildImageObjectKey("dev/products/p1/i1", 1600)).toBe("dev/products/p1/i1/1600.webp");
  });
});
