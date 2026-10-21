import "server-only";
import { cookies } from "next/headers";
import { siteOrigin } from "@/lib/site-origin";

// The checkout's order access cookie (docs/plans/cart-checkout.md §4.4, §9.2): lets a guest open
// the finish page of the order they just placed without a session. Holds the raw order access
// token placeOrder minted (only its sha256 is in `order_access_tokens`). httpOnly, so no page
// script ever reads it. Scoped to `/checkout`, which covers the finish page (session 10) and the
// checkout page whose server action posts there (a repeat submit proves with it that the guest
// placed the order, plan §5); the "Lihat pesanan" links in emails carry their own tokens (session
// 13).

export const ORDER_ACCESS_COOKIE_NAME = "ammari_checkout_order";
export const ORDER_ACCESS_COOKIE_PATH = "/checkout";
/** The finish page matters while paying and right after; the token row itself lives 120 days. */
const ORDER_ACCESS_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** The cookie's token, if the browser sent one. */
export async function readOrderAccessCookie(): Promise<string | null> {
  return (await cookies()).get(ORDER_ACCESS_COOKIE_NAME)?.value ?? null;
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
