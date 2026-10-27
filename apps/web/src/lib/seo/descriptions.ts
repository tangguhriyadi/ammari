import { META_DESCRIPTION_MAX_LENGTH, htmlToPlainText, truncateAtWord } from "./text";

// Meta description templates (docs/plans/seo.md §2). Indonesian, never empty.

/** "A, B, dan C" — Indonesian list joining. */
function joinIndonesian(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} dan ${items[items.length - 1]}`;
}

/** A product page's meta description: its storefront description as plain text, cut at a word
 * boundary; a product without one (or one that is only markup) gets a template from its name and
 * colours. `sanitizedDescriptionHtml` must already be sanitized (the page does it once). */
export function productMetaDescription(params: { name: string; sanitizedDescriptionHtml: string | null; colorNames: readonly string[] }): string {
  const text = params.sanitizedDescriptionHtml ? htmlToPlainText(params.sanitizedDescriptionHtml) : "";
  if (text) return truncateAtWord(text, META_DESCRIPTION_MAX_LENGTH);

  const colors = params.colorNames.filter((name) => name.trim().length > 0);
  const colorPart =
    colors.length === 0 ? "" : colors.length <= 4 ? ` Tersedia warna ${joinIndonesian(colors)}.` : ` Tersedia dalam ${colors.length} warna.`;
  return truncateAtWord(`${params.name.trim()}, busana syar'i dari Ammari.${colorPart} Pesan online di toko resmi Ammari.`, META_DESCRIPTION_MAX_LENGTH);
}

/** An info page's meta description: its published body as plain text, or the page's own template
 * while it is unpublished. */
export function infoPageMetaDescription(params: { sanitizedBodyHtml: string | null; fallback: string }): string {
  const text = params.sanitizedBodyHtml ? htmlToPlainText(params.sanitizedBodyHtml) : "";
  return truncateAtWord(text || params.fallback, META_DESCRIPTION_MAX_LENGTH);
}
