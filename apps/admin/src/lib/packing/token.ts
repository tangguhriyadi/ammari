import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { getMainSiteUrl, getMainSiteHost } from "@/lib/main-site-url";

// Crockford Base32 — deliberately excludes I/L/O/U (ambiguous against 1/0/V by hand or by eye),
// case-insensitive by convention (this alphabet is already uppercase-only; a future claim page
// must uppercase whatever the buyer types before matching against it).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encodes raw bytes into Crockford Base32, no padding — 16 bytes (128 bits) -> 26 characters.
 * Processes 5 bits at a time across the byte boundary with a small bit-buffer, the standard
 * base32 bit-packing approach (5 does not divide 8, so this can't be done byte-by-byte). */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** A fresh, unguessable claim token — 128 bits of randomness (docs/SPEC.md §4.2's minimum),
 * Crockford Base32-encoded to exactly 26 characters. This EXACT string is what goes in the QR's
 * URL (`${getMainSiteUrl()}/claim/<token>` — see claimUrl() below; SPEC §4.2 says no separate
 * short-path redirect) AND in the card's human-typable fallback text (grouped with dashes there
 * purely for legibility, e.g.
 * "XXXX-XXXX-XXXX-XXXX-XXXX-XX" — the dashes are decorative, never part of the real token).
 *
 * The future claim page (apps/web, not built yet) MUST, before hashing whatever a buyer typed by
 * hand: (1) uppercase it, (2) strip every non-alphanumeric character (the dashes above, and any
 * whitespace from a copy-paste). The QR's own URL form never has dashes, so hashing a
 * hand-typed value without this normalization would never match hashClaimToken's output for the
 * same logical token. */
export function generateClaimToken(): string {
  return base32Encode(randomBytes(16));
}

// Reminder for the future claim page (apps/web): validating a token is NOT just "does the hash
// match an active thank_you_cards row." `transitionOrderStatus` (lib/orders/queries.ts) voids a
// card the moment its order is cancelled/returned, so an `active` card normally implies a live
// order — but the claim page must still independently re-check the source order's status itself
// (not just the card's own status) before issuing a voucher, per docs/SPEC.md §4.3's claim
// checklist ("source order is not cancelled or returned"). Packing's own void-on-transition is a
// belt; this is the suspenders — the two paths aren't guaranteed to be perfectly serialized
// against a claim request arriving in the same instant.

/** sha256 of the token STRING (not the raw bytes) — this is what's stored in
 * thank_you_cards.token_hash, and what the future claim page must recompute (after the
 * normalization above) to look up a card by `tokenHash`. Hashing the string, not the raw bytes,
 * means the claim page never needs a base32-decode step — it only ever has the string form
 * (a URL path segment, or hand-typed input), so hashing that directly is both simpler and the
 * only form this function is ever asked to hash. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Groups a 26-character token into dash-separated blocks of 4 for the card's printed fallback
 * text only — never used for the QR's URL or for hashing (see generateClaimToken's own doc
 * comment on why the dashes are purely decorative). */
export function formatClaimTokenForDisplay(token: string): string {
  return token.match(/.{1,4}/g)?.join("-") ?? token;
}

/** The full, absolute URL the QR encodes — apps/web's own public base URL (validated by
 * lib/main-site-url.ts's `getMainSiteUrl()`; never hardcoded per environment). */
export function claimUrl(token: string): string {
  return `${getMainSiteUrl()}/claim/${token}`;
}

/** The card's printed fallback URL line — host + path, no token and no protocol (e.g.
 * "ammari.my.id/claim", not "https://ammari.my.id/claim/XXXX-..."). Printed on its own line,
 * with the grouped token (`formatClaimTokenForDisplay`) on the line below it: a buyer who can't
 * scan visits this URL, then types in the code shown underneath, rather than one long combined
 * line that forces an awkward line-break mid-token. Computed server-side only (this whole module
 * is server-only) and passed down to the client print view as a plain string. */
export function claimUrlHost(): string {
  return `${getMainSiteHost()}/claim`;
}
