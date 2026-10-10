"use server";

import { redirect } from "next/navigation";
import { normalizeClaimTokenInput } from "@/lib/claim/token";

/** Manual code entry has no token to validate yet — it only normalizes what was typed (same
 * strip-non-alphanumeric-then-uppercase rule the QR's own token already satisfies by
 * construction, docs/plans/voucher-claim.md) and hands off to `/claim/[token]`, which is the
 * ONE place that actually looks anything up. A blank/garbled code still redirects there and
 * simply renders as "not found" once the visitor is signed in — never a special case here. */
export async function enterClaimCodeAction(formData: FormData): Promise<void> {
  const raw = String(formData.get("code") ?? "");
  const normalized = normalizeClaimTokenInput(raw);
  if (!normalized) redirect("/claim?error=1");
  redirect(`/claim/${normalized}`);
}
