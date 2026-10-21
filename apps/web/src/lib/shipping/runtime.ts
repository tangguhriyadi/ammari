import "server-only";
import { shippingRuntimeFromEnv, type ShippingRuntime } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";

let lastLoggedProblems: string | null = null;

/** The shipping rate provider for this process (docs/plans/cart-checkout.md §12): Biteship when
 * its variables are set, the fake only in an e2e run, otherwise null, which callers answer as
 * "unavailable" (fail closed, §4.5.5). The problems are variable names only, never values, and the
 * same set is logged once per process rather than on every search keystroke. */
export function getShippingRuntime(): ShippingRuntime | null {
  const result = shippingRuntimeFromEnv(defaultDb, process.env);
  if (result.ok) {
    lastLoggedProblems = null;
    return result.runtime;
  }
  const signature = result.problems.join("|");
  if (signature !== lastLoggedProblems) {
    console.error("[shipping] rate provider not configured", { problems: result.problems });
    lastLoggedProblems = signature;
  }
  return null;
}
