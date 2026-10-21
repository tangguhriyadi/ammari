"use server";

import { addLinesToCart } from "@ammari/commerce/cart";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { clearGuestCartCookie, readCartWriteIdentity, writeGuestCartCookie } from "@/lib/cart/identity";
import {
  CART_CREATE_LIMIT,
  CART_CREATE_WINDOW_SECONDS,
  CART_GENERIC_ERROR_MESSAGE,
  CART_RATE_LIMITED_MESSAGE,
  CART_UNAVAILABLE_MESSAGE,
  CART_WRITE_LIMIT,
  CART_WRITE_WINDOW_SECONDS,
} from "@/lib/cart/messages";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { isOrderNo } from "./access";
import { loadReorderLines } from "./queries";
import { REORDER_LINE_MESSAGES, REORDER_UNAVAILABLE_MESSAGE } from "./reorder-messages";
import { findActionableOrderId } from "./visitor-access";

// "Pesan lagi" (docs/plans/cart-checkout.md §4.4, §9.1; owner decision 2026-10-21, session 15):
// puts the lines of a cancelled, never-paid checkout order back into the visitor's own cart, adding
// what fits (@ammari/commerce/cart addLinesToCart: the caps may cut a line, short stock skips it
// whole). A cart write like the others: behind the cart flag, the `cart_write` (and for a new guest
// cart `cart_create`) limits per IP, Next's Origin check as the CSRF guard. Only for an order the
// visitor may see (its session, the order page's cookie or the checkout's cookie); it only ever
// writes the visitor's own cart, never the order.

export type ReorderActionResult =
  | {
      ok: true;
      pieceCount: number;
      addedPieces: number;
      /** Lines that went in short or not at all, with the reason in words. */
      notes: { name: string; variant: string; message: string }[];
      mergeTrimmed: boolean;
    }
  | { ok: false; message: string };

export async function reorderAction(orderNo: string): Promise<ReorderActionResult> {
  if (!isCartEnabled()) return { ok: false, message: CART_UNAVAILABLE_MESSAGE };
  if (!isOrderNo(orderNo)) return { ok: false, message: REORDER_UNAVAILABLE_MESSAGE };
  try {
    const ip = await getCartClientIp("reorder");
    if (!ip) return { ok: false, message: CART_GENERIC_ERROR_MESSAGE };
    // Counted before the ownership lookup, so probing order numbers is throttled too.
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "cart_write", CART_WRITE_WINDOW_SECONDS)) >= CART_WRITE_LIMIT) return { ok: false, message: CART_RATE_LIMITED_MESSAGE };

    const orderId = await findActionableOrderId(orderNo);
    const lines = orderId ? await loadReorderLines(orderId) : null;
    if (!lines || lines.length === 0) return { ok: false, message: REORDER_UNAVAILABLE_MESSAGE };

    const { identity, guestToken, newGuestToken } = await readCartWriteIdentity();
    if (newGuestToken && (await recordClaimAttemptAndCount(defaultDb, ip, "cart_create", CART_CREATE_WINDOW_SECONDS)) >= CART_CREATE_LIMIT) {
      return { ok: false, message: CART_RATE_LIMITED_MESSAGE };
    }
    const result = await addLinesToCart(defaultDb, identity, lines);
    try {
      if (result.clearGuestCookie) await clearGuestCartCookie();
      if (guestToken && result.cartId) await writeGuestCartCookie(guestToken);
    } catch (error) {
      // The refill is committed: still answer with it (the next cart write sets the cookie again).
      console.error("[orders] reorder: cart cookie not updated after the refill", databaseErrorLogFields(error));
    }

    const bySku = new Map(lines.map((line) => [line.sku, line]));
    const notes = result.lines.flatMap((line) => {
      if (!line.reason) return [];
      const item = bySku.get(line.sku);
      if (!item) return [];
      return [{ name: item.name, variant: item.variant, message: REORDER_LINE_MESSAGES[line.reason] }];
    });
    return {
      ok: true,
      pieceCount: result.pieceCount,
      addedPieces: result.lines.reduce((sum, line) => sum + line.added, 0),
      notes,
      mergeTrimmed: result.mergeTrimmed,
    };
  } catch (error) {
    console.error("[orders] reorder failed", databaseErrorLogFields(error));
    return { ok: false, message: CART_GENERIC_ERROR_MESSAGE };
  }
}
