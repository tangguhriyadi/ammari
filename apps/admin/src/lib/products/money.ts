/** Parses Indonesian-formatted rupiah input ("269.000", "Rp 269.000", "Rp269000", "269000")
 * into a whole-rupiah integer. "." is always treated as a thousands separator (id-ID convention
 * — money is never fractional per CLAUDE.md), so a "," (an attempted decimal separator) and a
 * leading "-" are both rejected outright rather than silently reinterpreted. Returns `null` for
 * anything that isn't a valid whole non-negative amount. */
export function parseRupiah(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (trimmed.includes(",")) return null; // an attempted decimal — rupiah has none
  if (trimmed.startsWith("-")) return null;

  const withoutPrefix = trimmed.replace(/^rp\.?\s*/i, "");
  const digitsOnly = withoutPrefix.replace(/\./g, "");
  if (!/^\d+$/.test(digitsOnly)) return null;

  return Number.parseInt(digitsOnly, 10);
}
