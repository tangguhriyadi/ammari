import { describe, expect, test } from "vitest";
import { buildBreadcrumbJsonLd, buildOrganizationJsonLd, buildProductJsonLd, buildWebSiteJsonLd, serializeJsonLd, type ProductJsonLdInput } from "./json-ld";

const ORIGIN = "https://ammari.id";

const PRODUCT: ProductJsonLdInput = {
  name: "Gamis Aira",
  description: "Gamis syar'i premium.",
  url: `${ORIGIN}/products/gamis-aira`,
  images: ["https://img.ammari.id/p/1/1600.webp", "https://img.ammari.id/p/2/1600.webp"],
  price: 229_000,
  priceValidUntil: undefined,
  soldOut: false,
};

describe("buildProductJsonLd", () => {
  test("Product with brand, canonical url, every image and an IDR offer at the current price", () => {
    expect(buildProductJsonLd(PRODUCT)).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Gamis Aira",
      description: "Gamis syar'i premium.",
      url: `${ORIGIN}/products/gamis-aira`,
      image: PRODUCT.images,
      brand: { "@type": "Brand", name: "Ammari" },
      offers: {
        "@type": "Offer",
        url: `${ORIGIN}/products/gamis-aira`,
        priceCurrency: "IDR",
        price: 229_000,
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
        seller: { "@type": "Organization", name: "Ammari" },
      },
    });
  });

  test("a discount with an end carries priceValidUntil; a sold-out product is OutOfStock", () => {
    const ld = buildProductJsonLd({ ...PRODUCT, priceValidUntil: "2026-11-30", soldOut: true });
    const offers = ld.offers as Record<string, unknown>;
    expect(offers.priceValidUntil).toBe("2026-11-30");
    expect(offers.availability).toBe("https://schema.org/OutOfStock");
  });

  test("an empty description is left out rather than sent empty", () => {
    expect(buildProductJsonLd({ ...PRODUCT, description: "" })).not.toHaveProperty("description");
  });

  test("the offer url never carries ?color=", () => {
    const offers = buildProductJsonLd(PRODUCT).offers as Record<string, unknown>;
    expect(offers.url).not.toContain("?");
  });
});

describe("buildOrganizationJsonLd", () => {
  test("uses store settings when set", () => {
    const ld = buildOrganizationJsonLd({ origin: ORIGIN, supportEmail: "halo@ammari.id", whatsappNumber: "6281234567890" });
    expect(ld).toMatchObject({
      "@type": "Organization",
      "@id": `${ORIGIN}/#organization`,
      name: "Ammari",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/logos/ammari-mark-512.png`,
      email: "halo@ammari.id",
    });
    expect(ld.contactPoint).toEqual([
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        email: "halo@ammari.id",
        telephone: "+6281234567890",
        url: "https://wa.me/6281234567890",
        areaServed: "ID",
        availableLanguage: ["id"],
      },
    ]);
    expect(ld).not.toHaveProperty("sameAs");
  });

  test("falls back to the owner's contact when settings are empty", () => {
    const ld = buildOrganizationJsonLd({ origin: ORIGIN, supportEmail: null, whatsappNumber: " " });
    expect(ld.email).toBe("ammariofc@gmail.com");
    expect((ld.contactPoint as Record<string, unknown>[])[0]).toMatchObject({ telephone: "+6288808541442", url: "https://wa.me/6288808541442" });
  });

  test("a local 08 number gets the country code; a number with no digits falls back", () => {
    expect(buildOrganizationJsonLd({ origin: ORIGIN, supportEmail: null, whatsappNumber: "0812-3456-7890" }).contactPoint).toMatchObject([
      { telephone: "+6281234567890", url: "https://wa.me/6281234567890" },
    ]);
    expect(buildOrganizationJsonLd({ origin: ORIGIN, supportEmail: null, whatsappNumber: "WA" }).contactPoint).toMatchObject([{ telephone: "+6288808541442" }]);
  });

  test("sameAs only when social links exist", () => {
    const ld = buildOrganizationJsonLd({ origin: ORIGIN, supportEmail: null, whatsappNumber: null, sameAs: ["https://instagram.com/ammari"] });
    expect(ld.sameAs).toEqual(["https://instagram.com/ammari"]);
  });
});

describe("buildWebSiteJsonLd", () => {
  test("WebSite in Indonesian, published by the Organization", () => {
    expect(buildWebSiteJsonLd({ origin: ORIGIN, description: "Gamis syar'i." })).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${ORIGIN}/#website`,
      name: "Ammari",
      url: `${ORIGIN}/`,
      description: "Gamis syar'i.",
      inLanguage: "id-ID",
      publisher: { "@id": `${ORIGIN}/#organization` },
    });
  });
});

describe("buildBreadcrumbJsonLd", () => {
  test("ListItems numbered from 1, in order", () => {
    expect(
      buildBreadcrumbJsonLd([
        { name: "Beranda", url: `${ORIGIN}/` },
        { name: "Gamis Aira", url: `${ORIGIN}/products/gamis-aira` },
      ]),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Beranda", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Gamis Aira", item: `${ORIGIN}/products/gamis-aira` },
      ],
    });
  });
});

describe("serializeJsonLd", () => {
  test("a name containing </script> cannot close the tag, and the JSON still parses to the same value", () => {
    const data = buildProductJsonLd({ ...PRODUCT, name: 'Gamis </script><script>alert("x")</script> & <!-- Aira' });
    const serialized = serializeJsonLd(data);
    expect(serialized).not.toMatch(/<|>|&/);
    expect(JSON.parse(serialized)).toEqual(data);
  });

  test("line and paragraph separators are escaped", () => {
    const serialized = serializeJsonLd({ name: "a b c" });
    expect(serialized).toBe('{"name":"a\\u2028b\\u2029c"}');
    expect(JSON.parse(serialized)).toEqual({ name: "a b c" });
  });
});
