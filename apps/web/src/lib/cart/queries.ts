import "server-only";
import { getCartPieceCount, getCartView, type CartView } from "@ammari/commerce/cart";
import { isCartEnabled } from "@/lib/cart-flag";
import { defaultDb } from "@/lib/db";
import { readCartIdentity } from "./identity";

// Cart reads for server components (session 6: `/cart`, the header count). Uncached: the cart
// and its availability are re-read on every render (plan §4.2). A render cannot set cookies, so
// a merge here leaves the stale guest cookie in place; it names no cart any more and the next
// cart action clears it.

const EMPTY_CART: CartView = {
  cartId: null,
  lines: [],
  pieceCount: 0,
  subtotal: 0,
  savings: 0,
  canCheckout: false,
  clearGuestCookie: false,
  mergeTrimmed: false,
};

/** The current visitor's cart; empty while STOREFRONT_CART_ENABLED is off. */
export async function loadCartView(): Promise<CartView> {
  if (!isCartEnabled()) return EMPTY_CART;
  return getCartView(defaultDb, await readCartIdentity());
}

/** Pieces in the current visitor's cart; 0 while STOREFRONT_CART_ENABLED is off. */
export async function loadCartPieceCount(): Promise<number> {
  if (!isCartEnabled()) return 0;
  return getCartPieceCount(defaultDb, await readCartIdentity());
}
