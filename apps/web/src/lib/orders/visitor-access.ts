import "server-only";
import { getCustomerSession, type CustomerSessionData } from "@/lib/auth/customer-session";
import { decideConsentGate } from "@/lib/auth/consent";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { readOrderAccessCookie } from "@/lib/checkout/order-access-cookie";
import { defaultDb } from "@/lib/db";
import { findAccessibleOrder, isOrderNo, type OrderAccess } from "./access";
import { ORDER_VIEW_LIMIT, ORDER_VIEW_WINDOW_SECONDS } from "./limits";
import { readOrderViewCookie } from "./view-cookie";

// The current request's access to one order (./access.ts has the rule), for the order page and
// the actions it and the finish page post.

export type OrderPageAccess =
  | { kind: "ok"; access: OrderAccess; session: CustomerSessionData | null }
  /** Unknown, someone else's, a wrong or expired token: one answer for all. */
  | { kind: "none"; session: CustomerSessionData | null }
  | { kind: "consent"; to: string }
  | { kind: "limited" }
  | { kind: "error" };

/** The order page: the session first (its own orders), then the "Lihat pesanan" cookie, whose
 * lookups count toward the per-IP `order_view` limit. A session that sees the order but has not
 * given PDP consent yet goes through `/consent` first, like /account. */
export async function loadOrderPageAccess(orderNo: string): Promise<OrderPageAccess> {
  const session = await getCustomerSession();
  if (!isOrderNo(orderNo)) return { kind: "none", session };
  if (session) {
    const access = await findAccessibleOrder({ orderNo, sessionCustomerId: session.id, accessTokens: [] });
    if (access) {
      const gate = decideConsentGate(session, `/orders/${orderNo}`);
      return gate.action === "redirect" ? { kind: "consent", to: gate.to } : { kind: "ok", access, session };
    }
  }
  const token = await readOrderViewCookie();
  if (!token) return { kind: "none", session };
  const ip = await getCartClientIp("order page");
  if (!ip) return { kind: "error" };
  if ((await recordClaimAttemptAndCount(defaultDb, ip, "order_view", ORDER_VIEW_WINDOW_SECONDS)) >= ORDER_VIEW_LIMIT) return { kind: "limited" };
  const access = await findAccessibleOrder({ orderNo, sessionCustomerId: null, accessTokens: [token] });
  return access ? { kind: "ok", access, session } : { kind: "none", session };
}

/** For a server action posted from the order page or the finish page: the order's id when this
 * request may act on it (its session, the order page's cookie, or the checkout's cookie), else
 * null. Each action keeps its own rate limit, counted before this lookup. */
export async function findActionableOrderId(orderNo: unknown): Promise<string | null> {
  if (!isOrderNo(orderNo)) return null;
  const [session, viewToken, checkoutToken] = await Promise.all([getCustomerSession(), readOrderViewCookie(), readOrderAccessCookie()]);
  const access = await findAccessibleOrder({ orderNo, sessionCustomerId: session?.id ?? null, accessTokens: [viewToken, checkoutToken] });
  return access?.orderId ?? null;
}
