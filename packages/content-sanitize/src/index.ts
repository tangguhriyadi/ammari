import sanitizeHtml from "sanitize-html";

// docs/plans/storefront-cms.md ("Storefront description: rich-text editor + sanitization") —
// the TipTap editor is configured to only ever PRODUCE these 7 shapes (Document/Paragraph/Text/
// Bold/Italic/BulletList/OrderedList/ListItem/HardBreak), but this function is the actual
// security boundary: it must independently reject anything else, on the assumption that the
// HTML it receives could come from somewhere other than that editor (a direct DB edit, a future
// bug in the save path, a replayed request) — never trust the caller's claim that the input is
// already clean.
const STOREFRONT_DESCRIPTION_ALLOWED_TAGS = ["p", "strong", "em", "ul", "ol", "li", "br"];

// Phase 2 (docs/plans/storefront-cms.md, session 8) — info pages (Syarat & ketentuan, Kebijakan
// privasi, Cara pemesanan, Pengiriman, Pengembalian & penukaran) get ONE extra tag beyond the
// storefront description's set: `h2`. These are longer, sectioned documents (numbered clauses in
// a ToS, step-by-step ordering instructions) where a flat wall of paragraphs is genuinely harder
// to scan — unlike the storefront description's 1-2 marketing paragraphs, which never asked for
// section breaks. `h3` is deliberately left out: nothing in this feature calls for a second
// nesting level, and `h2` alone is enough for a single layer of section headings. Links stay
// declined for the same reason the storefront description declines them (no named use case, and
// a meaningfully larger sanitization surface — URL scheme allowlisting, open-redirect concerns,
// target/rel handling — for a feature that was never asked for).
const INFO_PAGE_ALLOWED_TAGS = [...STOREFRONT_DESCRIPTION_ALLOWED_TAGS, "h2"];

// A generous cap for 1-2 paragraphs of product description, not a real document — rejecting
// outright (rather than silently truncating) before doing any parsing work is both the safer
// and the cheaper response to a maliciously (or just accidentally, e.g. a pasted novel)
// oversized payload: sanitize-html still has to walk the whole DOM tree it parses, so this check
// runs BEFORE that happens.
export const MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH = 20_000;

// Info pages are real documents (a full Syarat & Ketentuan or Kebijakan Privasi can legitimately
// run to several thousand words) — a much larger cap than the storefront description's, but
// still a bound, and still rejected outright rather than silently truncated, same reasoning as
// above.
export const MAX_INFO_PAGE_HTML_LENGTH = 200_000;

export class ContentTooLargeError extends Error {
  constructor(public readonly maxLength: number) {
    super(`Content HTML exceeds the maximum allowed length of ${maxLength} characters.`);
    this.name = "ContentTooLargeError";
  }
}

/** Strict allowlist, both ends (docs/plans/storefront-cms.md) — called on EVERY save, server-side,
 * in the product form's storefront-description action, AND again, independently, at render time
 * in apps/web immediately before `dangerouslySetInnerHTML` (defense in depth: a second,
 * independent guarantee that holds even if a bad value ever got into the column some other way).
 *
 * `allowedAttributes: {}` — no attributes survive AT ALL, on any tag: no `class`/`style`/`id`,
 * and no `href` either, since links aren't part of the allowed feature set (see the plan's "No
 * links" note). This single setting is what makes event-handler attributes (`onclick`, `onerror`,
 * ...) and `javascript:`/`data:` URL schemes moot — there is no attribute slot left for either to
 * hide in, on any tag, allowed or not.
 *
 * A disallowed tag (anything outside the allowlist — headings beyond what's allowed, `<a>`,
 * `<img>`, `<table>`, a TipTap extension that was never supposed to be enabled, ...) is
 * unwrapped, not rejected: its text content survives, the tag itself and every attribute do not.
 * `<script>`/`<style>` are the one exception — sanitize-html's `nonTextTags` strips their
 * CONTENTS too (text nodes inside a `<script>` are code, not prose, so keeping them as plain text
 * would still leak the payload into the page, just unexecuted). Listed explicitly here (matching
 * sanitize-html's own default) so this stays correct even if a future sanitize-html major changes
 * that default. */
function sanitize(html: string, allowedTags: string[], maxLength: number): string {
  if (html.length > maxLength) {
    throw new ContentTooLargeError(maxLength);
  }
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
  });
}

export function sanitizeStorefrontDescriptionHtml(html: string): string {
  return sanitize(html, STOREFRONT_DESCRIPTION_ALLOWED_TAGS, MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH);
}

/** Same security posture as sanitizeStorefrontDescriptionHtml (see its own doc comment) —
 * `h2` is the only additional allowed tag, see INFO_PAGE_ALLOWED_TAGS above for why. Called on
 * EVERY save in the info-page editor's server action, AND again, independently, at render time
 * in apps/web's 5 info-page routes. */
export function sanitizeInfoPageHtml(html: string): string {
  return sanitize(html, INFO_PAGE_ALLOWED_TAGS, MAX_INFO_PAGE_HTML_LENGTH);
}
