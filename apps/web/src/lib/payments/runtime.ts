import "server-only";
import { paymentProviderFromEnv, paymentRuntimeFromEnv, type PaymentProvider, type PaymentRuntime } from "@ammari/commerce/payments";
import { siteOrigin } from "@/lib/site-origin";

let lastLoggedProblems: string | null = null;

/** The payment provider and checkout timing for this process (docs/plans/cart-checkout.md §12):
 * the fake only in an e2e run (`PAYMENT_PROVIDER=fake`), Midtrans when its variables are set, otherwise null,
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

let lastLoggedProviderProblems: string | null = null;

/** Only the payment provider, for the notification route: a bad checkout timing or prefix variable
 * never stops a paid notification from being verified and applied. */
export function getPaymentProvider(): PaymentProvider | null {
  const result = paymentProviderFromEnv(process.env, { siteOrigin: siteOrigin() });
  if (result.ok) {
    lastLoggedProviderProblems = null;
    return result.provider;
  }
  const signature = result.problems.join("|");
  if (signature !== lastLoggedProviderProblems) {
    console.error("[payments] payment provider not configured (notifications answer 503)", { problems: result.problems });
    lastLoggedProviderProblems = signature;
  }
  return null;
}
