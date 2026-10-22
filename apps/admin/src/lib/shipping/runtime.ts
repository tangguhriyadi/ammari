import "server-only";
import { shipmentRuntimeFromEnv, type ShipmentRuntime } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";

// The courier booking runtime as apps/admin sees it (docs/plans/cart-checkout.md §12, §15 Phase K,
// K2): "Pesan kurir", "Cek ulang pemesanan", "Batalkan pengiriman" and the label's refresh.
// Variables: BITESHIP_API_KEY, BITESHIP_BASE_URL, BITESHIP_ORIGIN_AREA_ID, BITESHIP_SHIPPER_NAME /
// _PHONE / _ADDRESS, BITESHIP_REFERENCE_PREFIX, BITESHIP_DAILY_ORDERS_BUDGET, DEPLOY_ENV
// (SHIPPING_ORDER_PROVIDER=fake only in an e2e run). Fails closed: without a valid configuration
// this returns null and booking is refused with a message; the manual resi path stays open.

let loggedProblems: string | null = null;

export function getAdminShipmentRuntime(env: NodeJS.ProcessEnv = process.env): ShipmentRuntime | null {
  const result = shipmentRuntimeFromEnv(defaultDb, env);
  if (result.ok) return result.runtime;
  const problems = result.problems.join("; ");
  // Variable names only (never values); once per distinct problem set, not per request.
  if (problems !== loggedProblems) {
    loggedProblems = problems;
    console.warn("[shipping] admin courier booking not configured; Pesan kurir is refused", { problems: result.problems });
  }
  return null;
}
