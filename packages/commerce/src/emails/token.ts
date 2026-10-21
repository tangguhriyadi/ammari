import "server-only";
import { createHmac } from "node:crypto";

// The "Lihat pesanan" token in an order email (docs/plans/cart-checkout.md §8, §9.2). Every email
// carries its own token, but a retried send must be byte-identical (the email provider's
// idempotency key only deduplicates an identical payload), and the raw token is never stored. So
// the token is derived from the notification row: HMAC-SHA256 over the notification id with a
// server secret (owner decision 2026-10-21, session 13: apps/web's CUSTOMER_BETTER_AUTH_SECRET with
// this purpose label, so no new env var). Only its sha256 goes into `order_access_tokens`, exactly
// like a random token, and it has the same shape (43 base64url characters). Session 14's login
// links can use the same idea under their own label.

const PURPOSE = "ammari:order-email-access-token:v1:";

export function deriveOrderEmailAccessToken(secret: string, notificationId: string): string {
  return createHmac("sha256", secret).update(PURPOSE + notificationId).digest("base64url");
}
