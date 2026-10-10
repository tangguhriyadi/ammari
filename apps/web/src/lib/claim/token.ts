import "server-only";
import { createHash } from "node:crypto";

/** Strips every non-alphanumeric character (the printed fallback's decorative dashes, and any
 * whitespace from a copy-paste) and uppercases what's left — the exact normalization
 * apps/admin's packing plan documents for this page (see apps/admin/src/lib/packing/token.ts's
 * own doc comment on `generateClaimToken`). Applied to BOTH manual entry (`/claim`) and the
 * token segment of `/claim/[token]` before hashing, so a hand-typed code and a scanned QR
 * normalize to the same string. */
export function normalizeClaimTokenInput(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** sha256 of the normalized token STRING — must match `hashClaimToken` in
 * apps/admin/src/lib/packing/token.ts exactly (same hash, same input shape) since that's what
 * computed `thank_you_cards.token_hash` at mint time. Duplicated here rather than imported: the
 * admin module pulls in admin-only dependencies (`@/lib/main-site-url`) and apps/web has no
 * access to apps/admin's `src/` tree across the monorepo boundary — this is the one pure
 * function actually needed on this side. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
