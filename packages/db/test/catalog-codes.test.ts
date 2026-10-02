import { describe, expect, test } from "vitest";
import { generateProductCode, generateSku, generateSlug } from "../src/catalog/codes";

describe("generateProductCode", () => {
  test("uppercases and strips non-alphanumeric characters — from the PRODUCT name, not a fabric", () => {
    expect(generateProductCode("Contoh Gamis A")).toBe("CONTOHGAMISA");
  });

  test("strips diacritics", () => {
    expect(generateProductCode("Café Édition")).toBe("CAFEEDITION");
  });

  test("falls back to PRODUK when the name has no alphanumeric characters", () => {
    expect(generateProductCode("!!!")).toBe("PRODUK");
  });
});

describe("generateSku", () => {
  test("joins code-closure-color-size, matching the 'Contoh Gamis A' example", () => {
    expect(
      generateSku({ code: generateProductCode("Contoh Gamis A"), closure: "front_zip", color: "Sage", size: "M" }),
    ).toBe("CONTOHGAMISA-FZ-SAGE-M");
  });

  test("back_zip abbreviates to BZ", () => {
    expect(generateSku({ code: "CODE", closure: "back_zip", color: "Mocca", size: "S" })).toBe("CODE-BZ-MOCCA-S");
  });

  test("multi-word colors collapse to one token", () => {
    expect(generateSku({ code: "CODE", closure: "front_zip", color: "Dusty Pink", size: "L" })).toBe(
      "CODE-FZ-DUSTYPINK-L",
    );
  });

  test("ALLSIZE is used as-is for all_size products", () => {
    expect(generateSku({ code: "CODE", closure: "front_zip", color: "Black", size: "ALLSIZE" })).toBe(
      "CODE-FZ-BLACK-ALLSIZE",
    );
  });

  test("lowercase input is still uppercased in the final SKU", () => {
    expect(generateSku({ code: "code", closure: "front_zip", color: "sage", size: "M" })).toBe("CODE-FZ-SAGE-M");
  });

  test("strips diacritics from the color", () => {
    expect(generateSku({ code: "CODE", closure: "front_zip", color: "Café", size: "M" })).toBe("CODE-FZ-CAFE-M");
  });
});

describe("generateSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(generateSlug("Contoh Gamis A")).toBe("contoh-gamis-a");
  });

  test("strips punctuation", () => {
    expect(generateSlug("Gamis Basic (Edisi Lebaran)!")).toBe("gamis-basic-edisi-lebaran");
  });

  test("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(generateSlug("  Gamis   --- Basic  ")).toBe("gamis-basic");
  });

  test("strips diacritics", () => {
    expect(generateSlug("Café Élégant")).toBe("cafe-elegant");
  });
});
