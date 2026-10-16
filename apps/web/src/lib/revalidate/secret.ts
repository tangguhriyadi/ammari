import "server-only";
import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison — length is checked first (a plain, non-secret property; the
 * secret's LENGTH was never meant to be hidden, only its content), then `timingSafeEqual` on two
 * equal-length buffers. A naive `===` would let an attacker recover the secret byte-by-byte by
 * timing how far a guess gets before the first mismatch; this is the standard mitigation Node's
 * own `crypto` docs recommend. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Validates the `x-revalidate-secret` header against `REVALIDATE_SECRET` — the ONLY auth this
 * machine-to-machine endpoint has (no staff session, see docs/plans/storefront-cms.md session 6).
 * Fails closed if the env var itself is missing (misconfiguration must never silently accept
 * every request) — logged loudly rather than thrown, so a misconfigured deploy returns a clean
 * 401 instead of a 500 that would hint the route exists but is broken. */
export function isValidRevalidateSecret(candidate: string | null): boolean {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) {
    console.error("REVALIDATE_SECRET is not set — rejecting every /api/revalidate request.");
    return false;
  }
  if (!candidate) return false;
  return constantTimeEqual(candidate, expected);
}
