import "server-only";
import { createHash, randomBytes } from "node:crypto";

// Order access tokens (docs/plans/cart-checkout.md §9.2): 32 random bytes, base64url; only the
// sha256 is stored in `order_access_tokens`. placeOrder mints one for the checkout cookie that
// lets a guest open their own finish page (§4.4); every email later mints its own.

/** Plan §9.2: each token works for 120 days from issuance. */
export const ORDER_ACCESS_TOKEN_DAYS = 120;

const TOKEN_BYTES = 32;
// 32 bytes in unpadded base64url is exactly 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateOrderAccessToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Anything else (tampered, truncated) is treated as no token, so an arbitrary string is never
 * hashed and looked up. */
export function isWellFormedOrderAccessToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashOrderAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
