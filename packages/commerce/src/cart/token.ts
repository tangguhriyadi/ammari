import "server-only";
import { createHash, randomBytes } from "node:crypto";

// The guest cart cookie value (docs/plans/cart-checkout.md §4.1, D2): 32 random bytes,
// base64url, so 256 bits. Only its sha256 is stored (`carts.token_hash`).

const CART_TOKEN_BYTES = 32;
// 32 bytes in unpadded base64url is exactly 43 characters.
const CART_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateCartToken(): string {
  return randomBytes(CART_TOKEN_BYTES).toString("base64url");
}

/** Anything else in the cookie (tampered, truncated, an old format) is treated as no cookie, so
 * an arbitrary string is never hashed and looked up. */
export function isWellFormedCartToken(value: string): boolean {
  return CART_TOKEN_PATTERN.test(value);
}

export function hashCartToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
