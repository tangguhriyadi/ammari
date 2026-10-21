import type { NextRequest } from "next/server";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { isOrderNo, redeemOrderViewToken } from "@/lib/orders/access";
import { ORDER_VIEW_LIMIT, ORDER_VIEW_WINDOW_SECONDS } from "@/lib/orders/limits";
import { ORDER_VIEW_COOKIE_NAME, orderViewCookieAttributes } from "@/lib/orders/view-cookie";

// The "Lihat pesanan" link from order emails, `/orders/<orderNo>?t=<token>` (docs/plans/
// cart-checkout.md §9.2), lands here through next.config.ts's rewrite (only when the query has
// `t`), so the URL with the token never renders a page. An unexpired token of that order is moved
// into the order's own httpOnly cookie (lib/orders/view-cookie.ts); then, whatever happened, the
// browser is sent to the token-free `/orders/<orderNo>` (303), which also drops the token from the
// address bar and history. Every refusal (unknown order, wrong or expired token) redirects the same
// way without a cookie, so the answer never tells whether the order exists; the page then shows its
// one "cannot show this order" state. No body, `Referrer-Policy: no-referrer` (nothing on this
// response can load or link anything, and the token URL is never sent as a Referer), never cached.
// The token is never logged.

export const dynamic = "force-dynamic";

function redirectTo(location: string, cookie?: { orderNo: string; token: string; expiresAt: Date }): Response {
  const headers = new Headers({
    Location: location,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  const response = new Response(null, { status: 303, headers });
  if (cookie) {
    const attributes = orderViewCookieAttributes(cookie.orderNo, cookie.expiresAt);
    const parts = [
      `${ORDER_VIEW_COOKIE_NAME}=${cookie.token}`,
      `Path=${attributes.path}`,
      `Expires=${attributes.expires.toUTCString()}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(attributes.secure ? ["Secure"] : []),
    ];
    response.headers.append("Set-Cookie", parts.join("; "));
  }
  return response;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ orderNo: string }> }): Promise<Response> {
  const { orderNo } = await params;
  // Anything that is not an order number cannot be one; its own page answers "not found" too.
  if (!isOrderNo(orderNo)) return redirectTo("/orders");
  const cleanUrl = `/orders/${orderNo}`;

  try {
    const ip = await getCartClientIp("order view link");
    if (!ip) return redirectTo(`${cleanUrl}?status=error`);
    // Counted before the lookup, so guessing tokens is throttled too.
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "order_view", ORDER_VIEW_WINDOW_SECONDS)) >= ORDER_VIEW_LIMIT) {
      return redirectTo(`${cleanUrl}?status=limited`);
    }
    const token = request.nextUrl.searchParams.get("t");
    const redeemed = token ? await redeemOrderViewToken(orderNo, token) : null;
    // Only a token that was just matched by its hash is ever written back (it is 43 base64url
    // characters, so it needs no escaping in the cookie).
    return redeemed && token ? redirectTo(cleanUrl, { orderNo, token, expiresAt: redeemed.expiresAt }) : redirectTo(cleanUrl);
  } catch (error) {
    console.error("[orders] order view link failed", databaseErrorLogFields(error));
    return redirectTo(`${cleanUrl}?status=error`);
  }
}
