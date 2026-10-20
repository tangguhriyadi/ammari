"use server";

import { z } from "zod";
import { addCartItem, removeCartItem, setCartItemQty, type CartWriteResult } from "@ammari/commerce/cart";
import { CART_MAX_QTY_PER_LINE, CART_REFUSAL_MESSAGES } from "@ammari/commerce/cart-limits";
import { isCartEnabled } from "@/lib/cart-flag";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { getCartClientIp } from "./ip";
import { clearGuestCartCookie, readCartWriteIdentity, writeGuestCartCookie, type CartWriteIdentity } from "./identity";
import {
  CART_CREATE_LIMIT,
  CART_CREATE_WINDOW_SECONDS,
  CART_GENERIC_ERROR_MESSAGE,
  CART_INVALID_INPUT_MESSAGE,
  CART_RATE_LIMITED_MESSAGE,
  CART_UNAVAILABLE_MESSAGE,
  CART_WRITE_LIMIT,
  CART_WRITE_WINDOW_SECONDS,
} from "./messages";

// Cart writes (docs/plans/cart-checkout.md §4.1, §4.2). Server actions only: Next's built-in
// Origin check is the CSRF guard (plan §10), the cookie is httpOnly, and prices, stock and caps
// are all decided by @ammari/commerce/cart on the server. Every action re-checks the flag itself,
// so with STOREFRONT_CART_ENABLED off nothing here touches the database.

export type CartActionResult =
  | { ok: true; pieceCount: number; mergeTrimmed: boolean }
  | { ok: false; message: string };

// SKUs are short codes; the cap only stops an oversized payload from reaching a query.
const skuSchema = z.string().trim().min(1).max(100);
const qtySchema = z.number().int().min(1).max(CART_MAX_QTY_PER_LINE);
const lineInput = z.object({ sku: skuSchema, qty: qtySchema });
const removeInput = z.object({ sku: skuSchema });

type CartWrite = (identity: CartWriteIdentity["identity"]) => Promise<CartWriteResult>;

async function runCartAction(write: CartWrite, createsCart: boolean): Promise<CartActionResult> {
  if (!isCartEnabled()) return { ok: false, message: CART_UNAVAILABLE_MESSAGE };
  try {
    return await runEnabledCartAction(write, createsCart);
  } catch (error) {
    // Every expected outcome is a returned message; this is a real failure (database down, a
    // bug). Logged without the cookie or any token.
    console.error("[cart] cart action failed", error);
    return { ok: false, message: CART_GENERIC_ERROR_MESSAGE };
  }
}

async function runEnabledCartAction(write: CartWrite, createsCart: boolean): Promise<CartActionResult> {
  const ip = await getCartClientIp();
  if (!ip) return { ok: false, message: CART_GENERIC_ERROR_MESSAGE };
  const priorAttempts = await recordClaimAttemptAndCount(defaultDb, ip, "cart_write", CART_WRITE_WINDOW_SECONDS);
  if (priorAttempts >= CART_WRITE_LIMIT) return { ok: false, message: CART_RATE_LIMITED_MESSAGE };

  const { identity, guestToken, newGuestToken } = await readCartWriteIdentity();
  if (createsCart && newGuestToken) {
    const priorCreates = await recordClaimAttemptAndCount(defaultDb, ip, "cart_create", CART_CREATE_WINDOW_SECONDS);
    if (priorCreates >= CART_CREATE_LIMIT) return { ok: false, message: CART_RATE_LIMITED_MESSAGE };
  }
  const result = await write(identity);
  // A customer's write has already merged any guest cart (even when the write itself is
  // refused), so the guest cookie names nothing any more.
  if (identity.customerId && identity.guestTokenHash) await clearGuestCartCookie();
  if (!result.ok) return { ok: false, message: CART_REFUSAL_MESSAGES[result.reason] };

  if (guestToken && result.cartId) await writeGuestCartCookie(guestToken);
  return { ok: true, pieceCount: result.pieceCount, mergeTrimmed: result.mergeTrimmed };
}

/** "Tambah ke keranjang" (PDP). Adds `qty` to the line. */
export async function addToCartAction(input: { sku: string; qty: number }): Promise<CartActionResult> {
  const parsed = lineInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: CART_INVALID_INPUT_MESSAGE };
  return runCartAction((identity) => addCartItem(defaultDb, identity, parsed.data.sku, parsed.data.qty), true);
}

/** The `/cart` stepper: sets the line to `qty`. */
export async function updateCartItemQtyAction(input: { sku: string; qty: number }): Promise<CartActionResult> {
  const parsed = lineInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: CART_INVALID_INPUT_MESSAGE };
  return runCartAction((identity) => setCartItemQty(defaultDb, identity, parsed.data.sku, parsed.data.qty), false);
}

/** The `/cart` "Hapus" / ×. */
export async function removeCartItemAction(input: { sku: string }): Promise<CartActionResult> {
  const parsed = removeInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: CART_INVALID_INPUT_MESSAGE };
  return runCartAction((identity) => removeCartItem(defaultDb, identity, parsed.data.sku), false);
}
