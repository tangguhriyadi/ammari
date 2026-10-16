import "server-only";
import { createHmac } from "node:crypto";

// Mints the SAME signed-token shape apps/web/src/lib/preview/token.ts verifies — duplicated
// here (not imported) because apps/admin has no access to apps/web's `src/` tree across the
// monorepo boundary, exactly the reasoning apps/web/src/lib/claim/token.ts's own doc comment
// gives for duplicating apps/admin/src/lib/packing/token.ts's hashClaimToken instead of
// importing it. Signing-only on this side (admin only ever MINTS a preview link; verifying it
// is apps/web's job) — keep the PURPOSE string and TTL in sync with that module if either ever
// changes.
const PURPOSE = "homepage-draft";
const TTL_SECONDS = 15 * 60;

function getPreviewSecret(): string {
  const secret = process.env.PREVIEW_SECRET;
  if (!secret) throw new Error("PREVIEW_SECRET is not set.");
  return secret;
}

/** A fresh token good for 15 minutes from now — minted server-side only by
 * createHomepagePreviewLinkAction below, never generated client-side, never stored anywhere
 * (docs/plans/storefront-cms.md session 6's "Preview" section). */
export function generateHomepagePreviewToken(now: Date = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + TTL_SECONDS;
  const mac = createHmac("sha256", getPreviewSecret()).update(`${PURPOSE}:${expiresAt}`).digest("hex");
  return `${expiresAt}.${mac}`;
}
