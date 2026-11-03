import "server-only";
import { midtransSignatureKeyFallsBackInProduction, paymentProviderFromEnv, paymentRuntimeFromEnv, type PaymentProvider, type PaymentRuntime } from "@ammari/commerce/payments";
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
let warnedSignatureKeyFallback = false;

/** Once per process: production Midtrans verifying notifications with the server key (no
 * MIDTRANS_SIGNATURE_KEY). Names only. */
function warnSignatureKeyFallback(): void {
  if (warnedSignatureKeyFallback || !midtransSignatureKeyFallsBackInProduction(process.env)) return;
  warnedSignatureKeyFallback = true;
  console.warn("[payments] MIDTRANS_SIGNATURE_KEY is not set in production mode; notifications are verified with MIDTRANS_SERVER_KEY (the newer Midtrans dashboard signs them with a separate Signature Secret Key, so they would all be refused)");
}

/** Only the payment provider, without logging: the provider, or the variable names (never values)
 * that keep it from being built. For the expiry sweep, which logs and answers the names every run. */
export function getPaymentProviderConfig(): { provider: PaymentProvider; problems: [] } | { provider: null; problems: string[] } {
  const result = paymentProviderFromEnv(process.env, { siteOrigin: siteOrigin() });
  return result.ok ? { provider: result.provider, problems: [] } : { provider: null, problems: result.problems };
}

/** Only the payment provider, for the notification route: a bad checkout timing or prefix variable
 * never stops a paid notification from being verified and applied. */
export function getPaymentProvider(): PaymentProvider | null {
  const result = getPaymentProviderConfig();
  if (result.provider) {
    lastLoggedProviderProblems = null;
    warnSignatureKeyFallback();
    return result.provider;
  }
  const signature = result.problems.join("|");
  if (signature !== lastLoggedProviderProblems) {
    console.error("[payments] payment provider not configured (notifications answer 503)", { problems: result.problems });
    lastLoggedProviderProblems = signature;
  }
  return null;
}
