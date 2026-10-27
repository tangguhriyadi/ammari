import { describe, expect, test } from "vitest";
import { infoPageMetaDescription, productMetaDescription } from "./descriptions";

describe("productMetaDescription", () => {
  test("uses the storefront description as clean plain text", () => {
    expect(
      productMetaDescription({
        name: "Gamis Aira",
        sanitizedDescriptionHtml: "<p>Gamis&nbsp;syar&#39;i <strong>premium</strong>.</p><ul><li>Busui friendly</li></ul>",
        colorNames: ["Sage"],
      }),
    ).toBe("Gamis syar'i premium. Busui friendly");
  });

  test("a long description is cut at a word boundary to at most 160 characters", () => {
    const long = `<p>${"Bahan adem dan jatuh, nyaman dipakai seharian. ".repeat(10)}</p>`;
    const result = productMetaDescription({ name: "Gamis Aira", sanitizedDescriptionHtml: long, colorNames: [] });
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(/\s…$/);
  });

  test("no description (or markup only) falls back to an Indonesian template with the colours", () => {
    for (const html of [null, "<p><br></p>"]) {
      expect(productMetaDescription({ name: "Gamis Aira", sanitizedDescriptionHtml: html, colorNames: ["Sage", "Mocca", "Navy"] })).toBe(
        "Gamis Aira, busana syar'i dari Ammari. Tersedia warna Sage, Mocca dan Navy. Pesan online di toko resmi Ammari.",
      );
    }
  });

  test("the template counts colours instead of listing more than four, and works with none", () => {
    expect(productMetaDescription({ name: "Gamis Aira", sanitizedDescriptionHtml: null, colorNames: ["A", "B", "C", "D", "E"] })).toContain(
      "Tersedia dalam 5 warna.",
    );
    expect(productMetaDescription({ name: "Gamis Aira", sanitizedDescriptionHtml: null, colorNames: [] })).toBe(
      "Gamis Aira, busana syar'i dari Ammari. Pesan online di toko resmi Ammari.",
    );
  });

  test("is never empty and never over 160 characters, even for a very long name", () => {
    const result = productMetaDescription({ name: "Gamis ".repeat(40), sanitizedDescriptionHtml: null, colorNames: ["Sage"] });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});

describe("infoPageMetaDescription", () => {
  test("uses the published body as text", () => {
    expect(infoPageMetaDescription({ sanitizedBodyHtml: "<h2>Kurir</h2><p>Dikirim &amp; dikemas rapi.</p>", fallback: "x" })).toBe(
      "Kurir Dikirim & dikemas rapi.",
    );
  });

  test("falls back while unpublished or empty", () => {
    expect(infoPageMetaDescription({ sanitizedBodyHtml: null, fallback: "Informasi pengiriman." })).toBe("Informasi pengiriman.");
    expect(infoPageMetaDescription({ sanitizedBodyHtml: "<p></p>", fallback: "Informasi pengiriman." })).toBe("Informasi pengiriman.");
  });
});
