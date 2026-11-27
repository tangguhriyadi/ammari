import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Webhook signature check (docs/plans/tiktok-shop-integration.md §0 "Webhooks", §8.1): the
// `Authorization` header is the lowercase hex of HMAC-SHA256(key = app_secret, app_key + raw body).
// The body is the exact received bytes, never a re-serialized parse. The header must be exactly 64
// lowercase hex characters; anything else (uppercase, wrong length, a `Bearer` prefix) is refused
// before any comparison. The comparison itself is constant-time over two 32-byte digests.

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export interface WebhookVerifyInput {
  appKey: string;
  appSecret: string;
  /** The exact bytes of the request body as received. A string is taken as its UTF-8 bytes. */
  rawBody: Uint8Array | string;
  /** The `Authorization` header value, or null when absent. */
  authorization: string | null | undefined;
}

export function computeWebhookSignature(appKey: string, appSecret: string, rawBody: Uint8Array | string): Buffer {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return createHmac("sha256", appSecret).update(Buffer.from(appKey, "utf8")).update(body).digest();
}

export function verifyWebhookSignature({ appKey, appSecret, rawBody, authorization }: WebhookVerifyInput): boolean {
  if (typeof authorization !== "string" || !SIGNATURE_PATTERN.test(authorization)) return false;
  // With an empty secret anyone could forge the signature: never accept one.
  if (appKey.length === 0 || appSecret.length === 0) return false;
  const received = Buffer.from(authorization, "hex");
  const expected = computeWebhookSignature(appKey, appSecret, rawBody);
  // Both are 32 bytes here (64 hex chars validated above); the length check keeps timingSafeEqual
  // from throwing should that ever change.
  return received.length === expected.length && timingSafeEqual(received, expected);
}
