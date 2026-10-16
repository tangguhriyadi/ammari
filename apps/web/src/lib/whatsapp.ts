// Pure, isomorphic helpers — imported from both the PDP's server component (building the initial
// href) and its client-side size/colour picker (rebuilding the href as the shopper's selection
// changes), so this file must NOT be "server-only". The WhatsApp NUMBER itself is read
// server-side only (see lib/store-settings.ts) and passed down as a prop.

/** `number` must already be in `wa.me` format (country code, digits only, no "+" — e.g.
 * "6281234567890") — validated/normalized wherever it's configured (today: an env var, see
 * lib/store-settings.ts; later: the store_settings admin form), not re-validated here. */
export function buildWhatsappUrl(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/** docs/design/storefront.md §6 item 6 — prefilled with product name, colour, size, and the page
 * URL. `size` is `null` before the shopper has picked one. */
export function buildProductWhatsappMessage(params: { productName: string; colorName: string; size: string | null; url: string }): string {
  const sizePart = params.size ? `, Ukuran ${params.size}` : "";
  return `Halo, saya mau tanya tentang ${params.productName} (Warna ${params.colorName}${sizePart}). ${params.url}`;
}
