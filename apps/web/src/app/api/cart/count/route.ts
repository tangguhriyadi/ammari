import { isCartEnabled } from "@/lib/cart-flag";
import { loadCartPieceCount } from "@/lib/cart/queries";

// The header cart count (docs/plans/cart-checkout.md §4.2), fetched by the browser on every page
// instead of being rendered into the layout: the PDP and other pages are ISR-cached, and a count
// baked into their HTML would show one visitor's cart to everyone. Route handlers are not cached
// by default; `private, no-store` also keeps any browser or CDN cache from holding one cart's
// count. Flag off: 404, like `/cart`.

// Explicit, although route handlers are already dynamic by default here: a later caching config
// must never turn one visitor's count into a shared response.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(): Promise<Response> {
  if (!isCartEnabled()) return new Response(null, { status: 404, headers: NO_STORE });
  try {
    return Response.json({ pieceCount: await loadCartPieceCount() }, { headers: NO_STORE });
  } catch (error) {
    // The header just shows the bag without a number; logged without cookies or tokens.
    console.error("[cart] count read failed", error);
    return Response.json({ error: "unavailable" }, { status: 500, headers: NO_STORE });
  }
}
