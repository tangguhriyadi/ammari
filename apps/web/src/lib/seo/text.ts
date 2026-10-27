// Pure text helpers for meta descriptions and JSON-LD (docs/plans/seo.md). Isomorphic, no DB.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      // Out-of-range or a lone surrogate would throw / produce garbage: keep the text as it was.
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text from ALREADY-SANITIZED storefront/info-page HTML (allowlisted tags, no attributes:
 * @ammari/content-sanitize), so a tag regex is enough. Inline tags (`strong`, `em`) vanish, every
 * other tag becomes a space (so "</p><p>" never glues two words together), entities are decoded,
 * whitespace (incl. nbsp) collapsed. The result is text, not HTML: React escapes it in a meta tag,
 * `serializeJsonLd` in a script. */
export function htmlToPlainText(sanitizedHtml: string): string {
  return decodeEntities(sanitizedHtml.replace(/<\/?(?:strong|em|b|i|u|span)\b[^>]*>/gi, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut at the last word boundary with "…" when anything was dropped.
 * A single word longer than `max` is cut hard. Trailing punctuation before the ellipsis goes. */
export function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // Never end on half of a surrogate pair (an emoji at the cut).
  const room = clean.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace > max / 2 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s,.;:!?–—-]+$/u, "")}…`;
}

/** Google shows roughly this much of a description; the homepage field uses the same guidance. */
export const META_DESCRIPTION_MAX_LENGTH = 160;
