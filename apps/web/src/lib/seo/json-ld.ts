// schema.org JSON-LD builders (docs/plans/seo.md §2). Pure: the pages pass resolved data in
// (price for this request, absolute URLs), so every shape is unit-testable without a DB.

export const SITE_NAME = "Ammari";

/** Used when Pengaturan Toko has no email / WhatsApp number (owner-provided, 2026-10-27). */
export const ORGANIZATION_FALLBACK_EMAIL = "ammariofc@gmail.com";
export const ORGANIZATION_FALLBACK_WHATSAPP = "6288808541442";

export const ORGANIZATION_LOGO_PATH = "/logos/ammari-primary.png";

type JsonLd = Record<string, unknown>;

/** Safe inside `<script type="application/ld+json">`: `JSON.stringify` alone leaves `</script>`
 * (or `<!--`) in a product name able to close the tag, so `<`, `>` and `&` are escaped as JSON
 * unicode escapes (still the same JSON value), plus U+2028/U+2029 for old parsers. */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface ProductJsonLdInput {
  name: string;
  /** Plain text, may be empty (then omitted). */
  description: string;
  /** Canonical, absolute (no `?color=`). */
  url: string;
  /** Absolute; at least one (the placeholder when the product has no photo). */
  images: readonly string[];
  /** Whole rupiah charged right now (product discount included). */
  price: number;
  /** YYYY-MM-DD, only while a discount with an end is active. */
  priceValidUntil: string | undefined;
  soldOut: boolean;
}

export function buildProductJsonLd(input: ProductJsonLdInput): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    url: input.url,
    image: [...input.images],
    brand: { "@type": "Brand", name: SITE_NAME },
    offers: {
      "@type": "Offer",
      url: input.url,
      priceCurrency: "IDR",
      price: input.price,
      ...(input.priceValidUntil ? { priceValidUntil: input.priceValidUntil } : {}),
      availability: input.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: SITE_NAME },
    },
  };
}

export interface OrganizationJsonLdInput {
  origin: string;
  /** From store settings; null falls back to the owner-provided contact. */
  supportEmail: string | null;
  /** wa.me format (digits, country code, no "+"); null falls back likewise. */
  whatsappNumber: string | null;
  /** Social profile URLs; none exist in store settings today. */
  sameAs?: readonly string[];
}

export function buildOrganizationJsonLd(input: OrganizationJsonLdInput): JsonLd {
  const email = input.supportEmail?.trim() || ORGANIZATION_FALLBACK_EMAIL;
  // Digits first, then the fallback, so a value with no digits never yields "+". A local "08..."
  // number becomes "628..." (wa.me and E.164 both need the country code).
  const digits = (input.whatsappNumber ?? "").replace(/\D/g, "").replace(/^0/, "62");
  const whatsappDigits = digits || ORGANIZATION_FALLBACK_WHATSAPP;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${input.origin}/#organization`,
    name: SITE_NAME,
    url: `${input.origin}/`,
    logo: `${input.origin}${ORGANIZATION_LOGO_PATH}`,
    email,
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        email,
        telephone: `+${whatsappDigits}`,
        url: `https://wa.me/${whatsappDigits}`,
        areaServed: "ID",
        availableLanguage: ["id"],
      },
    ],
    ...(input.sameAs && input.sameAs.length > 0 ? { sameAs: [...input.sameAs] } : {}),
  };
}

export function buildWebSiteJsonLd(params: { origin: string; description: string }): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${params.origin}/#website`,
    name: SITE_NAME,
    url: `${params.origin}/`,
    description: params.description,
    inLanguage: "id-ID",
    publisher: { "@id": `${params.origin}/#organization` },
  };
}

/** `items` in order from the homepage; each `url` absolute. */
export function buildBreadcrumbJsonLd(items: readonly { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.name, item: item.url })),
  };
}

export const HOME_BREADCRUMB_NAME = "Beranda";
