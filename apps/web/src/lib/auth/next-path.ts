const DEFAULT_NEXT_PATH = "/account";

// Mirrors better-auth's own `isSafeRelativeURL` (node_modules/better-auth/dist/auth/
// trusted-origins.mjs) almost exactly — that function already gets this right and is used to
// validate `callbackURL` on every better-auth endpoint, so this app's own `?next=` handling
// (which never goes through better-auth at all — it's a plain client `router.push` after OTP
// sign-in, and a plain server `redirect` in the consent action) needs the same rigor, not a
// hand-rolled denylist. An earlier version of this function only rejected a LITERAL leading
// "//" or "/\\", which the WHATWG URL spec's mandatory "strip every ASCII tab/newline/CR
// anywhere in the string" pre-processing step bypasses: "/\t/evil.com" doesn't match any of
// those literal checks, but a real browser (or Next's client router) parses it as "//evil.com"
// — an absolute, cross-origin URL — after stripping the tab.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const RELATIVE_URL_PARSER_ORIGIN = "https://ammari-internal.invalid";
const ENCODED_PATH_SEPARATOR_PATTERN = /%2[fF]|%5[cC]/;

function isSafeRelativePath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const pathEnd = value.search(/[?#]/);
  const path = pathEnd === -1 ? value : value.slice(0, pathEnd);
  if (ENCODED_PATH_SEPARATOR_PATTERN.test(path)) return false;
  try {
    // If `value` is truly root-relative, resolving it against ANY origin lands back on that
    // same origin — a value that smuggles an absolute/protocol-relative target resolves
    // somewhere else instead, which this catches regardless of which specific trick it uses.
    return new URL(value, RELATIVE_URL_PARSER_ORIGIN).origin === RELATIVE_URL_PARSER_ORIGIN;
  } catch {
    return false;
  }
}

/** Guards against an open redirect via `?next=` — only an internal, same-origin path is ever
 * followed. Call this once, at the page boundary where the raw `next` search param is read
 * (every redirect target built downstream — login, consent — then works with an already-
 * trusted value), and again at the layer that actually builds a redirect URL (defense in depth
 * — see consent.ts and require-customer.ts). */
export function sanitizeNextPath(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return DEFAULT_NEXT_PATH;
  return isSafeRelativePath(value) ? value : DEFAULT_NEXT_PATH;
}
