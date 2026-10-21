import "server-only";
import { cookies } from "next/headers";
import { siteOrigin } from "@/lib/site-origin";

// The checkout's order access cookie (docs/plans/cart-checkout.md §4.4, §9.2): lets a guest open
// the finish page of the order they just placed without a session. Holds the raw order access
// token placeOrder minted (only its sha256 is in `order_access_tokens`). httpOnly, so no page
// script ever reads it. Scoped to the whole site since the 2026-10-21 sandbox run (was `/checkout`):
// a buyer who leaves the payment page with the back button must be told on /cart, /checkout and
// the product page that their order is waiting for payment, and "Ganti metode pembayaran" posts
// from those pages (lib/checkout/pending-order.ts). It still proves only that one order, exactly as
// before (the finish page, a repeat submit, plan §5); the "Lihat pesanan" links in emails carry
// their own tokens (session 13).

export const ORDER_ACCESS_COOKIE_NAME = "ammari_checkout_order_v2";
/** The name before the path became `/` (2026-10-21). A browser can still hold one (scoped to
 * `/checkout`, at most 7 days): read only when the new cookie is absent, never written. A new name
 * rather than the same name on a new path, because browsers send both same-name cookies (longest
 * path first) and the old one would shadow the new order's token on /checkout (security review). */
const LEGACY_ORDER_ACCESS_COOKIE_NAME = "ammari_checkout_order";
export const ORDER_ACCESS_COOKIE_PATH = "/";
/** The finish page matters while paying and right after; the token row itself lives 120 days. */
const ORDER_ACCESS_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** The cookie's token, if the browser sent one. */
export async function readOrderAccessCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ORDER_ACCESS_COOKIE_NAME)?.value ?? jar.get(LEGACY_ORDER_ACCESS_COOKIE_NAME)?.value ?? null;
}

/** Server actions only. A later checkout replaces it (the cookie names the latest order). */
export async function writeOrderAccessCookie(token: string): Promise<void> {
  (await cookies()).set(ORDER_ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    // Always Secure in a production build, whatever the origin variable says (fails closed).
    secure: process.env.NODE_ENV === "production" || siteOrigin().startsWith("https://"),
    sameSite: "lax",
    path: ORDER_ACCESS_COOKIE_PATH,
    maxAge: ORDER_ACCESS_COOKIE_MAX_AGE_SECONDS,
  });
}
