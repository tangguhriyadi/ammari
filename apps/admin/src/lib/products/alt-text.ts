/** The default alt text a product photo gets when nobody typed one: "<product> warna <color>"
 * for a color photo (e.g. "Haura Dress warna Taupe"), just "<product>" for a general photo.
 *
 * MUST stay identical to the SQL expression in migration 0028 (the one-time backfill) and in
 * image-queries.ts's fillMissingAltTexts/sync*AltTexts, which rebuild the same string in
 * Postgres: an alt text is only ever treated as "still the default" (and so safe to rewrite on a
 * rename) when it equals this exact string. */
export function defaultImageAltText(productName: string, colorName: string | null): string {
  return colorName ? `${productName} warna ${colorName}` : productName;
}
