import { isCartEnabled } from "@/lib/cart-flag";
import { loadPendingCheckoutOrder } from "@/lib/checkout/pending-order";

// The product page's "Kamu punya pesanan ... yang menunggu pembayaran" (lib/checkout/pending-order.ts),
// fetched by the browser like the header cart count: product pages are ISR-cached, and one visitor's
// order must never be baked into their shared HTML. Only the visitor's own order (session or the
// checkout cookie), `private, no-store`. Flag off: 404, like `/cart`.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(): Promise<Response> {
  if (!isCartEnabled()) return new Response(null, { status: 404, headers: NO_STORE });
  // loadPendingCheckoutOrder never throws: a failed read answers "no order" (it is a reminder).
  return Response.json({ order: await loadPendingCheckoutOrder() }, { headers: NO_STORE });
}
