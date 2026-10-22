import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Authentication for the courier webhook (docs/plans/cart-checkout.md §15 Phase K "Webhook vs
// polling", K3). Biteship signs nothing; its dashboard webhook form only sends a static header
// ("Headers Signature Key / Secret") on every post. So two secrets from the environment:
// - BITESHIP_WEBHOOK_PATH_TOKEN: a long random path segment
//   (`/api/shipping/biteship/webhook/<token>`), so the URL itself is not guessable;
// - BITESHIP_WEBHOOK_HEADER_NAME / BITESHIP_WEBHOOK_HEADER_SECRET: the header Biteship sends (the
//   form's key and secret).
// Both compared in constant time (as SHA-256 digests, so the lengths always match). Even a post that
// passes both is only a hint: the route re-fetches the order from Biteship and applies only that.
// Problems name variables only, never values.

export const WEBHOOK_SECRET_MIN_LENGTH = 32;
const PATH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_SECRET_PATTERN = /^[\x21-\x7e]{32,256}$/;
/** Headers a proxy, the browser or HTTP itself sets or rewrites: never usable as the secret's carrier. */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "connection",
  "user-agent",
  "accept",
  "accept-encoding",
  "transfer-encoding",
  "x-ammari-proxy",
  "x-real-ip",
]);

export interface WebhookSecrets {
  pathToken: string;
  headerName: string;
  headerSecret: string;
}

export type WebhookSecretsResult = { ok: true; secrets: WebhookSecrets } | { ok: false; problems: string[] };

export function webhookSecretsFromEnv(env: Readonly<Record<string, string | undefined>>): WebhookSecretsResult {
  const problems: string[] = [];
  const pathToken = env.BITESHIP_WEBHOOK_PATH_TOKEN?.trim() ?? "";
  const headerName = env.BITESHIP_WEBHOOK_HEADER_NAME?.trim().toLowerCase() ?? "";
  const headerSecret = env.BITESHIP_WEBHOOK_HEADER_SECRET?.trim() ?? "";
  if (!PATH_TOKEN_PATTERN.test(pathToken)) problems.push("BITESHIP_WEBHOOK_PATH_TOKEN must be 32 to 128 characters of A-Z, a-z, 0-9, '-' or '_'");
  if (!HEADER_NAME_PATTERN.test(headerName) || RESERVED_HEADER_NAMES.has(headerName) || headerName.startsWith("x-forwarded-") || headerName.startsWith("cf-")) {
    problems.push("BITESHIP_WEBHOOK_HEADER_NAME must be a plain header name (A-Z, 0-9, '-'), not a standard or proxy header");
  }
  if (!HEADER_SECRET_PATTERN.test(headerSecret)) problems.push("BITESHIP_WEBHOOK_HEADER_SECRET must be 32 to 256 printable characters without spaces");
  // Two factors only if they differ, and a placeholder of one repeated character is not a secret.
  if (pathToken !== "" && pathToken === headerSecret) problems.push("BITESHIP_WEBHOOK_PATH_TOKEN and BITESHIP_WEBHOOK_HEADER_SECRET must differ");
  for (const [name, value] of [["BITESHIP_WEBHOOK_PATH_TOKEN", pathToken], ["BITESHIP_WEBHOOK_HEADER_SECRET", headerSecret]] as const) {
    if (value !== "" && new Set(value).size < 8) problems.push(`${name} looks like a placeholder (too few different characters); use openssl rand -hex 32`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, secrets: { pathToken, headerName, headerSecret } };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function same(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** `bad_path`: the path token is wrong (checked first: a caller without the URL learns nothing about
 * the header). `missing_header`: no header of that name, or an empty one (the dashboard's header
 * fields not saved, or a proxy dropped it). `bad_header`: present, wrong value. */
export type WebhookAuthFailure = "bad_path" | "missing_header" | "bad_header";
export type WebhookAuth = { ok: true } | { ok: false; failed: WebhookAuthFailure };

/** Both checks always run (a wrong path token does not answer faster than a wrong header). The
 * header value is trimmed like the env value (Headers.get already drops the outer whitespace). */
export function authorizeWebhook(secrets: WebhookSecrets, pathToken: string, headers: Headers): WebhookAuth {
  const pathOk = same(pathToken, secrets.pathToken);
  const sent = headers.get(secrets.headerName)?.trim() ?? "";
  const headerOk = same(sent, secrets.headerSecret);
  if (!pathOk) return { ok: false, failed: "bad_path" };
  if (sent === "") return { ok: false, failed: "missing_header" };
  if (!headerOk) return { ok: false, failed: "bad_header" };
  return { ok: true };
}
