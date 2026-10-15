import sanitizeHtml from "sanitize-html";

// docs/plans/storefront-cms.md ("Storefront description: rich-text editor + sanitization") —
// the TipTap editor is configured to only ever PRODUCE these 7 shapes (Document/Paragraph/Text/
// Bold/Italic/BulletList/OrderedList/ListItem/HardBreak), but this function is the actual
// security boundary: it must independently reject anything else, on the assumption that the
// HTML it receives could come from somewhere other than that editor (a direct DB edit, a future
// bug in the save path, a replayed request) — never trust the caller's claim that the input is
// already clean.
const ALLOWED_TAGS = ["p", "strong", "em", "ul", "ol", "li", "br"];

// A generous cap for 1-2 paragraphs of product description, not a real document — rejecting
// outright (rather than silently truncating) before doing any parsing work is both the safer
// and the cheaper response to a maliciously (or just accidentally, e.g. a pasted novel)
// oversized payload: sanitize-html still has to walk the whole DOM tree it parses, so this check
// runs BEFORE that happens.
export const MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH = 20_000;

export class ContentTooLargeError extends Error {
  constructor(public readonly maxLength: number = MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH) {
    super(`Storefront description HTML exceeds the maximum allowed length of ${maxLength} characters.`);
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
 * A disallowed tag (anything outside ALLOWED_TAGS — headings, `<a>`, `<img>`, `<table>`, a
 * TipTap extension that was never supposed to be enabled, ...) is unwrapped, not rejected: its
 * text content survives, the tag itself and every attribute do not. `<script>`/`<style>` are the
 * one exception — sanitize-html's `nonTextTags` strips their CONTENTS too (text nodes inside a
 * `<script>` are code, not prose, so keeping them as plain text would still leak the payload
 * into the page, just unexecuted). Listed explicitly here (matching sanitize-html's own default)
 * so this stays correct even if a future sanitize-html major changes that default. */
export function sanitizeStorefrontDescriptionHtml(html: string): string {
  if (html.length > MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH) {
    throw new ContentTooLargeError();
  }
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
  });
}
