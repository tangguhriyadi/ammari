import { describe, expect, test } from "vitest";
import type { ProductGallery, ProductGalleryItem } from "@/lib/content/product-view";
import { colorJumpIndex, nextIndex, prevIndex } from "./index-math";

function item(id: string, colorId: string | null): ProductGalleryItem {
  return { id, storageKey: id, altText: id, width: 800, height: 1200, colorId };
}

describe("nextIndex / prevIndex", () => {
  test("wrap at both ends", () => {
    expect(nextIndex(4, 5)).toBe(0);
    expect(prevIndex(0, 5)).toBe(4);
    expect(nextIndex(2, 5)).toBe(3);
    expect(prevIndex(2, 5)).toBe(1);
  });

  test("two photos: next and prev both reach the other one", () => {
    expect(nextIndex(0, 2)).toBe(1);
    expect(nextIndex(1, 2)).toBe(0);
    expect(prevIndex(0, 2)).toBe(1);
  });

  test("one photo stays on it; an empty gallery stays at 0", () => {
    expect(nextIndex(0, 1)).toBe(0);
    expect(prevIndex(0, 1)).toBe(0);
    expect(nextIndex(0, 0)).toBe(0);
    expect(prevIndex(0, 0)).toBe(0);
  });
});

describe("colorJumpIndex", () => {
  const withGeneral: ProductGallery = {
    images: [item("g1", null), item("g2", null), item("b1", "beige"), item("n1", "navy"), item("n2", "navy")],
    colorStartIndex: { beige: 2, navy: 3 },
  };

  test("a colour with photos jumps to its first photo, from anywhere (re-tapping included)", () => {
    expect(colorJumpIndex(withGeneral, "navy", 0)).toBe(3);
    expect(colorJumpIndex(withGeneral, "navy", 4)).toBe(3);
    expect(colorJumpIndex(withGeneral, "beige", 4)).toBe(2);
  });

  test("a colour without photos jumps to the first general photo", () => {
    expect(colorJumpIndex(withGeneral, "taupe", 4)).toBe(0);
  });

  test("a colour without photos on a product without general photos stays put", () => {
    const colourOnly: ProductGallery = { images: [item("b1", "beige"), item("n1", "navy")], colorStartIndex: { beige: 0, navy: 1 } };
    expect(colorJumpIndex(colourOnly, "taupe", 1)).toBe(1);
  });

  test("an empty gallery stays at its current index", () => {
    expect(colorJumpIndex({ images: [], colorStartIndex: {} }, "beige", 0)).toBe(0);
  });
});
