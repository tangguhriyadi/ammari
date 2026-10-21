import "server-only";
import { paymentProviderFromEnv, type PaymentProvider } from "@ammari/commerce/payments";

// The payment gateway as apps/admin sees it (docs/plans/cart-checkout.md §6.5, §12, session 16):
// only for a staff cancel of an UNPAID web order, which first asks the gateway for each attempt's
// status and expires a still pending one. Same variables and rules as apps/web's notification route
// (`MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `DEPLOY_ENV`; `PAYMENT_PROVIDER=fake` only in an
// e2e run). Fails closed: without a valid configuration this returns null and such a cancel is
// refused with a clear message; paid orders are cancelled without the gateway.

let loggedProblems: string | null = null;

export function getAdminPaymentProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  // The fake's payment page lives on the storefront; nothing in admin opens it.
  const siteOrigin = env.MAIN_SITE_URL?.trim() || "http://localhost:3000";
  const result = paymentProviderFromEnv(env, { siteOrigin });
  if (result.ok) return result.provider;
  const problems = result.problems.join("; ");
  // Variable names only (never values); once per distinct problem set, not per request.
  if (problems !== loggedProblems) {
    loggedProblems = problems;
    console.warn("[payments] admin payment provider not configured; unpaid web orders cannot be cancelled from admin", { problems: result.problems });
  }
  return null;
}
