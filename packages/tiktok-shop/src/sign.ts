import "server-only";
import { createHmac } from "node:crypto";

// TikTok Shop Open API request signing (docs/plans/tiktok-shop-integration.md §0 "Sign"):
//
//   sign = hex(HMAC-SHA256(key = app_secret,
//              app_secret + path + Σ sorted {key}{value} (excluding sign, access_token)
//              + exact raw body + app_secret))
//
// The body is appended exactly as it is sent, byte for byte: the caller serializes it once and
// sends that same string (./client.ts), so no re-serialization can change whitespace or key order.
// Query values are signed raw (decoded); URL-encoding happens only when the URL is built.

/** Never part of the string to sign. */
export const SIGN_EXCLUDED_PARAMS: ReadonlySet<string> = new Set(["sign", "access_token"]);

export type QueryParams = Readonly<Record<string, string>>;

export interface SignInput {
  appSecret: string;
  /** The request path, starting with `/` (e.g. `/authorization/202309/shops`). No query string. */
  path: string;
  /** Every query parameter that is sent, including `app_key` and `timestamp`. */
  query: QueryParams;
  /** The exact raw request body, or undefined/empty for a request without one. */
  body?: string;
}

/** Plain code-unit comparison, the same as the reference implementations' byte sort for the ASCII
 * keys TikTok uses. Deliberately not `localeCompare`, which depends on the runtime's locale. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildStringToSign({ appSecret, path, query, body }: SignInput): string {
  // An empty key gives an HMAC anyone can compute; refuse it rather than sign with it.
  if (appSecret.length === 0) throw new Error("sign: app secret is empty");
  if (!path.startsWith("/") || path.includes("?")) throw new Error("sign: path must start with / and carry no query string");
  const params = Object.keys(query)
    .filter((key) => !SIGN_EXCLUDED_PARAMS.has(key))
    .sort(compareKeys)
    .map((key) => `${key}${query[key]}`)
    .join("");
  return `${appSecret}${path}${params}${body ?? ""}${appSecret}`;
}

export function signRequest(input: SignInput): string {
  return createHmac("sha256", input.appSecret).update(buildStringToSign(input), "utf8").digest("hex");
}
