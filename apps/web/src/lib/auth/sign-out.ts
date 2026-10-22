import "server-only";
import { headers } from "next/headers";
import { resolveCart } from "@ammari/commerce/cart";
import { isCartEnabled } from "@/lib/cart-flag";
import { expireGuestCartCookie, readCartIdentity } from "@/lib/cart/identity";
import { clearOrderAccessCookies } from "@/lib/checkout/order-access-cookie";
import { defaultDb } from "@/lib/db";
import { clearOrderViewCookies } from "@/lib/orders/view-cookie";
import { customerAuth } from "./customer";

// Every storefront logout (the account page's "Keluar", the checkout's "Bukan kamu? Keluar") goes
// through here. Logout starts this browser fresh (owner feedback 2026-10-22, a shared device): the
// guest cart cookie, the checkout's order cookie (and its legacy name) and every "Lihat pesanan"
// cookie are expired, so the next person sees no cart, no "menunggu pembayaran" reminder and no
// order page. Nothing is deleted: orders, payments, tokens and cart rows all stay, and the
// account's cart comes back on its next login.

/** Server actions only. Callers redirect afterwards. The cookies are expired even when signing out
 * itself fails (the action then errors with this browser already cleared). */
export async function signOutCustomer(): Promise<void> {
  // Needs the session, so before signing out.
  if (isCartEnabled()) await mergeGuestCartBeforeSignOut();
  try {
    await customerAuth.api.signOut({ headers: await headers() });
  } finally {
    await Promise.all([expireGuestCartCookie(), clearOrderAccessCookies(), clearOrderViewCookies()]);
  }
}

/** A guest cart is merged into the account on the first cart read after login. One still waiting
 * for that read (logged in, never opened the cart) is merged now, so expiring its cookie never
 * strands it. A failure is logged, never a reason to keep the visitor signed in. */
async function mergeGuestCartBeforeSignOut(): Promise<void> {
  try {
    const identity = await readCartIdentity();
    if (identity.customerId && identity.guestTokenHash) await resolveCart(defaultDb, identity);
  } catch (error) {
    console.error("[auth] guest cart merge before logout failed; logging out anyway", {
      error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error,
    });
  }
}
