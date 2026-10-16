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

/** Formats an already-normalized wa.me number (same contract as {@link buildWhatsappUrl}) for
 * display to Indonesian readers, e.g. "6288808541442" → "+62 888 0854 1442": "+62", then the
 * rest grouped 3-4-4. Numbers outside that common length still group sensibly — groups of 4
 * after the leading 3, with a trailing group shorter than 3 digits folded into the group before
 * it instead of standing alone. Use this wherever a WhatsApp number is shown as text (footer,
 * and anywhere else it's displayed, not just linked). */
export function formatWhatsappNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  const rest = digits.startsWith("62") ? digits.slice(2) : digits;
  if (rest.length === 0) return "+62";

  const firstGroup = rest.slice(0, Math.min(3, rest.length));
  const groups: string[] = [firstGroup];
  for (let i = firstGroup.length; i < rest.length; i += 4) {
    groups.push(rest.slice(i, i + 4));
  }

  const lastGroup = groups[groups.length - 1];
  const secondLastGroup = groups[groups.length - 2];
  if (lastGroup !== undefined && secondLastGroup !== undefined && lastGroup.length < 3) {
    groups.pop();
    groups[groups.length - 1] = secondLastGroup + lastGroup;
  }

  return `+62 ${groups.join(" ")}`;
}
