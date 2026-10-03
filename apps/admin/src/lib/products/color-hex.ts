const SHORTHAND_HEX_PATTERN = /^#[0-9A-Fa-f]{3}$/;
const FULL_HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Normalizes "9caf88" / "#9caf88" / "#9CAF88" to "#9CAF88" (matching the DB CHECK constraint's
 * expected format), and expands 3-digit shorthand ("#000" / "#fa3") by doubling each digit, the
 * same rule CSS uses — "#fa3" -> "#FFAA33", "#000" -> "#000000". Returns `null` for anything
 * else. */
export function normalizeColorHex(input: string): string | null {
  const trimmed = input.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;

  if (SHORTHAND_HEX_PATTERN.test(withHash)) {
    const [r, g, b] = withHash.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  if (!FULL_HEX_PATTERN.test(withHash)) return null;
  return withHash.toUpperCase();
}
