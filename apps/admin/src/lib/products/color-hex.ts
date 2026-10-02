const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Normalizes "9caf88" / "#9caf88" / "#9CAF88" to "#9CAF88" (matching the DB CHECK constraint's
 * expected format); returns `null` for anything else. */
export function normalizeColorHex(input: string): string | null {
  const trimmed = input.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!HEX_PATTERN.test(withHash)) return null;
  return withHash.toUpperCase();
}
