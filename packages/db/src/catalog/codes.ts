import type { ProductClosure, Size } from "../schema/constants";

const CLOSURE_ABBREVIATIONS: Record<ProductClosure, string> = {
  front_zip: "FZ",
  back_zip: "BZ",
};

/** Uppercase, alphanumeric-only, derived from the PRODUCT name (never the fabric name — a
 * product's fabric can change over its life, but its code/SKU prefix must not). Falls back to
 * "PRODUK" if the name has no alphanumeric characters at all (e.g. pure emoji/punctuation). */
export function generateProductCode(name: string): string {
  const code = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return code.length > 0 ? code : "PRODUK";
}

/** Uppercase, alphanumeric-only color token for a SKU — "Dusty Pink" -> "DUSTYPINK". */
function colorToken(color: string): string {
  return color
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export interface GenerateSkuInput {
  code: string;
  closure: ProductClosure;
  color: string;
  size: Size;
}

/** Pure, stable SKU format: "{CODE}-{CLOSURE}-{COLOR}-{SIZE}", e.g. "POKA-FZ-SAGE-M" — except
 * "POKA" there is the PRODUCT's code, not a fabric name; see generateProductCode's doc comment.
 * Immutable once a variant exists: callers must never recompute a SKU for an existing row — this
 * only ever runs once, at the moment a variant is first created.
 *
 * Single implementation shared by apps/admin and packages/db's seed-dev.ts — previously each had
 * its own copy, which risked the two silently drifting apart (e.g. seed-dev.ts's copy didn't
 * strip diacritics the way this one does). */
export function generateSku({ code, closure, color, size }: GenerateSkuInput): string {
  return [code.toUpperCase(), CLOSURE_ABBREVIATIONS[closure], colorToken(color), size].join("-");
}

/** Lowercase, hyphenated, URL-safe — "Gamis Basic" -> "gamis-basic". Diacritics are stripped via
 * Unicode normalization (NFKD) before the alnum filter, so e.g. "Café" -> "cafe". */
export function generateSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
