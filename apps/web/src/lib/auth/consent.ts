import type { CustomerSessionData } from "./customer-session";
import { sanitizeNextPath } from "./next-path";

/** Pure, unit-testable decision logic behind the mandatory PDP consent step (decided plan,
 * option (c)): login itself never captures consent — it only creates the minimal identity
 * needed to authenticate. After sign-in, as long as `pdp_consent_at` is null, the claim and
 * account pages must not be usable. No "server-only"/Next import here on purpose, so this can
 * be unit-tested directly without mocking a request/response cycle. */
export function needsConsent(customer: Pick<CustomerSessionData, "pdpConsentAt">): boolean {
  return customer.pdpConsentAt === null;
}

export type ConsentGateDecision =
  | { action: "allow"; customer: CustomerSessionData }
  | { action: "redirect"; to: string };

/** The full gate a page needs: no session -> `/login`, a session but no consent -> `/consent`,
 * otherwise pass the live customer through. `next` is the path the caller actually wants to
 * land on once the gate clears — carried through both redirect targets so the user ends up
 * back where they started after logging in and/or consenting. */
export function decideConsentGate(customer: CustomerSessionData | null, next: string): ConsentGateDecision {
  // Sanitized again here, not just at the page boundary that first read `next` off the request
  // — this function builds the actual redirect target, so it's the layer that must not trust a
  // caller to have already done this (defense in depth against an open redirect).
  const safeNext = sanitizeNextPath(next);
  if (!customer) return { action: "redirect", to: `/login?next=${encodeURIComponent(safeNext)}` };
  if (needsConsent(customer)) return { action: "redirect", to: `/consent?next=${encodeURIComponent(safeNext)}` };
  return { action: "allow", customer };
}
