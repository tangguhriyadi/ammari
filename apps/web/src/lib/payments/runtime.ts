import "server-only";
import { paymentRuntimeFromEnv, type PaymentRuntime } from "@ammari/commerce/payments";
import { siteOrigin } from "@/lib/site-origin";

let lastLoggedProblems: string | null = null;

/** The payment provider and checkout timing for this process (docs/plans/cart-checkout.md §12):
 * the fake only in an e2e run (`PAYMENT_PROVIDER=fake`), Midtrans from session 11, otherwise null,
 * which checkout answers before creating anything (fail closed). The problems are variable names
 * only, never values, and the same set is logged once per process. */
export function getPaymentRuntime(): PaymentRuntime | null {
  const result = paymentRuntimeFromEnv(process.env, { siteOrigin: siteOrigin() });
  if (result.ok) {
    lastLoggedProblems = null;
    return result.runtime;
  }
  const signature = result.problems.join("|");
  if (signature !== lastLoggedProblems) {
    console.error("[payments] payment provider not configured", { problems: result.problems });
    lastLoggedProblems = signature;
  }
  return null;
}
