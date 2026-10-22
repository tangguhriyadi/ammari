import "server-only";
import { trackingRuntimeFromEnv, type ShipmentReader } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";

let lastLoggedProblems: string | null = null;

/** The courier tracking reader for this process (docs/plans/cart-checkout.md §15 Phase K, K3):
 * Biteship reads (the webhook's re-fetch, the poller) when its variables are set, the fake only in an
 * e2e run, otherwise null: the webhook then only logs and the poll answers 503. The problems are
 * variable names only, never values, logged once per process for each new set. */
export function getTrackingReader(): ShipmentReader | null {
  const result = trackingRuntimeFromEnv(defaultDb, process.env);
  if (result.ok) {
    lastLoggedProblems = null;
    return result.runtime.reader;
  }
  const signature = result.problems.join("|");
  if (signature !== lastLoggedProblems) {
    console.error("[shipping] courier tracking not configured", { problems: result.problems });
    lastLoggedProblems = signature;
  }
  return null;
}
