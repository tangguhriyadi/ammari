import "server-only";
import { cookies } from "next/headers";
import { ORDER_ACCESS_TOKEN_DAYS } from "@ammari/commerce/checkout";
import { siteOrigin } from "@/lib/site-origin";
import { isOrderNo } from "./access";

// The "Lihat pesanan" cookie (docs/plans/cart-checkout.md §9.2): the email link's token, moved out
// of the URL into an httpOnly cookie scoped to that one order's path, so the browser sends it only
// to `/orders/<orderNo>` (and the page's own server actions, which post to the same path). Every
// order opened this way gets its own cookie; a cookie for one order is never sent to another
// order's page.
//
// Logout clears them all (owner feedback 2026-10-22: nothing from the previous person may show on
// a shared device). A path-scoped cookie never reaches the logout's own request, so the site-wide
// index cookie below lists the order numbers that have one, and each order's cookie has its own
// name: Next's cookie store keeps one Set-Cookie per name, so a single response could not expire
// several same-named cookies on different paths. The name before 2026-10-22, `ammari_order_view`
// (the same on every order path), is no longer read: such a cookie could not be listed or cleared.

const ORDER_VIEW_COOKIE_PREFIX = "ammari_order_view_";
/** Site-wide, httpOnly: the order numbers this browser holds a "Lihat pesanan" cookie for. */
export const ORDER_VIEW_INDEX_COOKIE_NAME = "ammari_order_views";
/** Opening a further order drops the oldest one's cookie, so the index can always name them all. */
export const ORDER_VIEW_INDEX_MAX = 20;
const ORDER_VIEW_INDEX_MAX_AGE_SECONDS = ORDER_ACCESS_TOKEN_DAYS * 24 * 60 * 60;
const ORDER_VIEW_INDEX_SEPARATOR = ".";

export function orderViewCookieName(orderNo: string): string {
  return `${ORDER_VIEW_COOKIE_PREFIX}${orderNo}`;
}

export function orderViewCookiePath(orderNo: string): string {
  return `/orders/${orderNo}`;
}

function secureCookies(): boolean {
  // Always Secure in a production build, whatever the origin variable says (fails closed).
  return process.env.NODE_ENV === "production" || siteOrigin().startsWith("https://");
}

export function orderViewCookieAttributes(orderNo: string, expiresAt: Date) {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax" as const,
    path: orderViewCookiePath(orderNo),
    // Never outlives its token (120 days from the email that issued it).
    expires: expiresAt,
  };
}

export function orderViewIndexCookieAttributes() {
  return { httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, path: "/", maxAge: ORDER_VIEW_INDEX_MAX_AGE_SECONDS };
}

/** The index cookie's order numbers, oldest first. Anything that is not an order number is
 * dropped, so a tampered value can never name another cookie or path. */
export function parseOrderViewIndex(value: string | undefined): string[] {
  if (!value) return [];
  const orderNos = value.split(ORDER_VIEW_INDEX_SEPARATOR).filter(isOrderNo);
  return [...new Set(orderNos)].slice(-ORDER_VIEW_INDEX_MAX);
}

export function serializeOrderViewIndex(orderNos: readonly string[]): string {
  return orderNos.join(ORDER_VIEW_INDEX_SEPARATOR);
}

/** `orderNo` moved to the newest end; `evicted` are the orders past the cap, whose cookies the same
 * response must expire. */
export function addToOrderViewIndex(orderNos: readonly string[], orderNo: string): { orderNos: string[]; evicted: string[] } {
  const next = [...orderNos.filter((existing) => existing !== orderNo), orderNo];
  const overflow = Math.max(0, next.length - ORDER_VIEW_INDEX_MAX);
  return { orderNos: next.slice(overflow), evicted: next.slice(0, overflow) };
}

/** The token this request's cookie carries for that order's page, if any. */
export async function readOrderViewCookie(orderNo: string): Promise<string | null> {
  return (await cookies()).get(orderViewCookieName(orderNo))?.value ?? null;
}

/** Server actions only: expires every "Lihat pesanan" cookie the index names, and the index. */
export async function clearOrderViewCookies(): Promise<void> {
  const store = await cookies();
  const secure = secureCookies();
  for (const orderNo of parseOrderViewIndex(store.get(ORDER_VIEW_INDEX_COOKIE_NAME)?.value)) {
    store.delete({ name: orderViewCookieName(orderNo), path: orderViewCookiePath(orderNo), httpOnly: true, secure, sameSite: "lax" });
  }
  store.delete({ name: ORDER_VIEW_INDEX_COOKIE_NAME, path: "/", httpOnly: true, secure, sameSite: "lax" });
}
