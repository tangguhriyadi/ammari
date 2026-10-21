import "server-only";
import { cookies } from "next/headers";
import { siteOrigin } from "@/lib/site-origin";

// The "Lihat pesanan" cookie (docs/plans/cart-checkout.md §9.2): the email link's token, moved out
// of the URL into an httpOnly cookie scoped to that one order's path, so the browser sends it only
// to `/orders/<orderNo>` (and the page's own server actions, which post to the same path). Every
// order opened this way gets its own cookie (same name, different path); a cookie for one order is
// never sent to another order's page.

export const ORDER_VIEW_COOKIE_NAME = "ammari_order_view";

export function orderViewCookiePath(orderNo: string): string {
  return `/orders/${orderNo}`;
}

export function orderViewCookieAttributes(orderNo: string, expiresAt: Date) {
  return {
    httpOnly: true,
    // Always Secure in a production build, whatever the origin variable says (fails closed).
    secure: process.env.NODE_ENV === "production" || siteOrigin().startsWith("https://"),
    sameSite: "lax" as const,
    path: orderViewCookiePath(orderNo),
    // Never outlives its token (120 days from the email that issued it).
    expires: expiresAt,
  };
}

/** The token this request's cookie carries for the order page it was sent to, if any. */
export async function readOrderViewCookie(): Promise<string | null> {
  return (await cookies()).get(ORDER_VIEW_COOKIE_NAME)?.value ?? null;
}
