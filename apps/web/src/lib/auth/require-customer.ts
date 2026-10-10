import "server-only";
import { redirect } from "next/navigation";
import { getCustomerSession, type CustomerSessionData } from "./customer-session";
import { decideConsentGate } from "./consent";
import { sanitizeNextPath } from "./next-path";

/** No `proxy.ts` on apps/web (decided plan, #3) — most of this app is intentionally public, so
 * every protected page calls this (or `requireConsentedSession` below) itself rather than
 * relying on a coarse gate that would have nothing extra to protect. */
export async function requireCustomerSession(next: string): Promise<CustomerSessionData> {
  const customer = await getCustomerSession();
  if (!customer) redirect(`/login?next=${encodeURIComponent(sanitizeNextPath(next))}`);
  return customer;
}

/** The gate for the claim and account pages (decided plan, option (c)): a session alone isn't
 * enough — `pdp_consent_at` must be set too, or this redirects to `/consent` instead of letting
 * the page render. The claim server action (session 2) independently re-checks `needsConsent`
 * itself rather than trusting that a page-level redirect already happened — this function is
 * for pages, not a substitute for that server-side check. */
export async function requireConsentedSession(next: string): Promise<CustomerSessionData> {
  const customer = await getCustomerSession();
  const decision = decideConsentGate(customer, next);
  if (decision.action === "redirect") redirect(decision.to);
  return decision.customer;
}
