import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Single-purpose, short-lived signed tokens for the draft-homepage preview link
// (docs/plans/storefront-cms.md session 6) — NOT a real login. There's no customer-facing
// session this needs to integrate with; a signed, expiring link is exactly enough security for
// "only someone the owner handed this link to, for a few minutes, can see the draft." Minted
// server-side only by apps/admin's "Pratinjau" action (never generated client-side, never stored
// in the database — see that action's own doc comment).
//
// Token shape: "<expiresAtEpochSeconds>.<hmacHex>", where hmac = HMAC-SHA256(PREVIEW_SECRET,
// "<PURPOSE>:<expiresAtEpochSeconds>"). The literal purpose string is baked into what's signed
// so this token can never be reused for a different feature later (e.g. a future info-page
// preview) even if it shared the same secret and expiry shape.
const PURPOSE = "homepage-draft";
const DEFAULT_TTL_SECONDS = 15 * 60;

function getPreviewSecret(): string {
  const secret = process.env.PREVIEW_SECRET;
  if (!secret) throw new Error("PREVIEW_SECRET is not set.");
  return secret;
}

function sign(expiresAt: number): string {
  return createHmac("sha256", getPreviewSecret()).update(`${PURPOSE}:${expiresAt}`).digest("hex");
}

/** Mints a fresh token. `ttlSeconds`/`now` are only ever overridden by the e2e test backdoor
 * (api/test/preview-token/route.ts) to mint an already-expired token; every real caller uses the
 * defaults. */
export function generateHomepagePreviewToken(options: { ttlSeconds?: number; now?: Date } = {}): string {
  const now = options.now ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = Math.floor(now.getTime() / 1000) + ttlSeconds;
  return `${expiresAt}.${sign(expiresAt)}`;
}

/** Verifies a `?token=` query value: well-formed, not expired, and not tampered with — the HMAC
 * is checked with a constant-time comparison (same reasoning as
 * lib/revalidate/secret.ts's own `constantTimeEqual`: a naive string `===` would let an attacker
 * narrow down a forged signature byte-by-byte via response timing). Any failure (missing,
 * malformed, expired, tampered) returns `false` the same way — never distinguished, so a bad
 * guess learns nothing about which part was wrong. */
export function verifyHomepagePreviewToken(token: string, now: Date = new Date()): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiresAtRaw, mac] = parts;
  if (!expiresAtRaw || !mac) return false;
  if (!/^\d+$/.test(expiresAtRaw)) return false;
  if (!/^[0-9a-f]+$/i.test(mac)) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt)) return false;
  if (Math.floor(now.getTime() / 1000) > expiresAt) return false;

  const expected = Buffer.from(sign(expiresAt), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, "hex");
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
