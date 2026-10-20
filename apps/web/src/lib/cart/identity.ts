import "server-only";
import { cookies } from "next/headers";
import { generateCartToken, hashCartToken, isWellFormedCartToken, resolveCart, type CartIdentity } from "@ammari/commerce/cart";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { defaultDb } from "@/lib/db";
import { siteOrigin } from "@/lib/site-origin";

// The guest cart cookie (docs/plans/cart-checkout.md §4.1): httpOnly, Secure on https,
// SameSite=Lax, 60 days. Holds a 256-bit random token; only its sha256 is stored. Never readable
// by page scripts, so nothing client-side ever sees or sends it except the browser itself.

export const CART_COOKIE_NAME = "ammari_cart";
const CART_COOKIE_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

/** The cookie's token when it is well formed; anything else counts as no cookie. */
async function readGuestCartToken(): Promise<string | null> {
  const value = (await cookies()).get(CART_COOKIE_NAME)?.value;
  return value && isWellFormedCartToken(value) ? value : null;
}

/** Who is reading the cart: the session customer (re-read from `customers`, never the Better
 * Auth payload) and/or the guest cookie. Usable from a page render. */
export async function readCartIdentity(): Promise<CartIdentity> {
  const [customer, token] = await Promise.all([getCustomerSession(), readGuestCartToken()]);
  return { customerId: customer?.id ?? null, guestTokenHash: token ? hashCartToken(token) : null };
}

export interface CartWriteIdentity {
  identity: CartIdentity;
  /** Set for a guest: the cookie value to (re)write after a successful write. A brand-new token
   * when the browser had none, so the first "Tambah ke keranjang" creates the cart. */
  guestToken: string | null;
  /** `guestToken` was minted for this request (a new cart if the write is an add). */
  newGuestToken: boolean;
}

/** For a server action. A guest always gets a token; a customer only carries the cookie's hash
 * along so the write merges it.
 *
 * A guest's cookie token is reused only while it names a live guest cart. A well-formed token the
 * server never issued (or whose cart is gone) is replaced by a fresh one, so a token planted in a
 * victim's browser (cookie tossing) never becomes a cart the planter can also open. */
export async function readCartWriteIdentity(): Promise<CartWriteIdentity> {
  const [customer, existing] = await Promise.all([getCustomerSession(), readGuestCartToken()]);
  if (customer) {
    return {
      identity: { customerId: customer.id, guestTokenHash: existing ? hashCartToken(existing) : null },
      guestToken: null,
      newGuestToken: false,
    };
  }
  if (existing) {
    const guestTokenHash = hashCartToken(existing);
    const { cartId } = await resolveCart(defaultDb, { customerId: null, guestTokenHash });
    if (cartId) return { identity: { customerId: null, guestTokenHash }, guestToken: existing, newGuestToken: false };
  }
  const token = generateCartToken();
  return { identity: { customerId: null, guestTokenHash: hashCartToken(token) }, guestToken: token, newGuestToken: true };
}

/** Server actions and route handlers only (Next cannot set cookies during a render). Re-setting
 * on every guest write keeps an active cart's cookie alive for 60 days from its last use. */
export async function writeGuestCartCookie(token: string): Promise<void> {
  (await cookies()).set(CART_COOKIE_NAME, token, {
    httpOnly: true,
    // Always Secure in a production build, whatever the origin variable says (fails closed).
    secure: process.env.NODE_ENV === "production" || siteOrigin().startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: CART_COOKIE_MAX_AGE_SECONDS,
  });
}

/** After a merge into the customer's cart the guest cookie points at nothing; drop it. */
export async function clearGuestCartCookie(): Promise<void> {
  const store = await cookies();
  if (store.has(CART_COOKIE_NAME)) store.delete(CART_COOKIE_NAME);
}
