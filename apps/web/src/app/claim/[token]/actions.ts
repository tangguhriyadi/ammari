"use server";

import { redirect } from "next/navigation";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { normalizeClaimTokenInput, hashClaimToken } from "@/lib/claim/token";
import { claimVoucher } from "@/lib/claim/queries";
import { recordClaimAttemptAndCount, CLAIM_SUBMIT_WINDOW_SECONDS, CLAIM_SUBMIT_LIMIT } from "@/lib/claim/throttle";
import { getClaimClientIp } from "@/lib/claim/ip";
import { defaultDb } from "@/lib/db";
import {
  CLAIM_ALREADY_MINE_MESSAGE,
  CLAIM_GENERIC_ERROR_MESSAGE,
  CLAIM_RATE_LIMITED_MESSAGE,
  CLAIM_REJECTION_MESSAGES,
} from "@/lib/claim/messages";

export type ClaimActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; amount: number; expiresAt: string };

export async function claimAction(_prev: ClaimActionState, formData: FormData): Promise<ClaimActionState> {
  const token = String(formData.get("token") ?? "");
  const next = `/claim/${encodeURIComponent(token)}`;

  // Re-checks session AND consent itself (decided plan, option (c)) — never trusts that the
  // page that rendered this form's button already gated both, the same defense-in-depth every
  // other apps/web page applies individually.
  const customer = await requireConsentedSession(next);

  const ip = await getClaimClientIp();
  const attempts = await recordClaimAttemptAndCount(defaultDb, ip, "claim", CLAIM_SUBMIT_WINDOW_SECONDS);
  if (attempts >= CLAIM_SUBMIT_LIMIT) {
    return { status: "error", message: CLAIM_RATE_LIMITED_MESSAGE };
  }

  const tokenHash = hashClaimToken(normalizeClaimTokenInput(token));
  const outcome = await claimVoucher(tokenHash, customer, defaultDb);

  if (outcome.ok) {
    return { status: "success", amount: outcome.voucher.amount, expiresAt: outcome.voucher.expiresAt.toISOString() };
  }

  if (outcome.reason === "consent_required") {
    // Can only happen if consent was revoked/never set between requireConsentedSession's own
    // check above and this transaction — redirect rather than show a message, same as every
    // other consent gate in this app.
    redirect(`/consent?next=${encodeURIComponent(next)}`);
  }

  if (outcome.reason === "claimed" && outcome.claimedByCustomerId === customer.id) {
    return { status: "error", message: CLAIM_ALREADY_MINE_MESSAGE };
  }

  return { status: "error", message: CLAIM_REJECTION_MESSAGES[outcome.reason] ?? CLAIM_GENERIC_ERROR_MESSAGE };
}
