"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Minus, Plus, X } from "lucide-react";
import { cn } from "@ammari/ui";
import type { CartLine } from "@ammari/commerce/cart";
import { CART_LINE_STATUS_MESSAGES, CART_MAX_PIECES, CART_MAX_QTY_PER_LINE } from "@ammari/commerce/cart-limits";
import { removeCartItemAction, updateCartItemQtyAction, type CartActionResult } from "@/lib/cart/actions";
import { announceCartCount, announceCartStatus, CART_CALL_FAILED_MESSAGE, CART_HEADING_ID } from "@/lib/cart/count-event";
import { formatPriceIdr } from "@/lib/format";
import { ProductImage } from "@/components/product-image";
import { useOptimisticCart, type OptimisticCartUpdate } from "./optimistic-cart";
import { failedCallMessage } from "@/lib/stale-deployment";

export interface CartLineItemProps {
  line: CartLine;
  /** Resolved on the server (the storage base URL is not a public env var). */
  imageUrl: string | null;
  /** The cart is below the 20-piece cap, so a "+" can still succeed (outside the optimistic
   * provider; inside it the optimistic piece count decides). */
  canAddPieces: boolean;
}

/** One `/cart` line (docs/plans/cart-checkout.md §4.2, docs/design/storefront.md §7). A line that
 * can still be bought has the 1 to 10 stepper and ×; a sold-out or no longer available line shows
 * only its state and "Hapus". Every change goes through a server action, which re-checks stock
 * and the caps and answers with a fresh render of the page. Never shows a stock number.
 *
 * Optimistic (./optimistic-cart.tsx): the quantity, line total, subtotal and header count change
 * on the tap; a refusal rolls them back and shows the server's message. Stepper taps are not
 * blocked while one is in flight: each sends the absolute quantity computed from what the buyer
 * sees, and Next runs server actions one at a time in order, so the last tap wins. Boundary states
 * use `aria-disabled` plus a guard instead of `disabled`, so a keyboard user's focus stays on the
 * button they are pressing. */
export function CartLineItem({ line: serverLine, imageUrl, canAddPieces }: CartLineItemProps) {
  const cart = useOptimisticCart();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const optimisticLine = cart ? cart.lines.find((candidate) => candidate.sku === serverLine.sku) : serverLine;
  // Removed on the tap: hidden until the server's render drops it (or a refusal brings it back).
  // It stays mounted all along, so a refusal's message lands on the returning row.
  const line = optimisticLine ?? serverLine;
  const buyable = line.status === "ok" || line.status === "insufficient";
  const variantLabel = `${line.colorName} · ${line.sizeLabel}`;
  const itemName = `${line.productName}, ${line.colorName}, ${line.sizeLabel}`;

  function run(update: OptimisticCartUpdate, action: () => Promise<CartActionResult>, done: string, onApplied?: () => void) {
    setError(null);
    const before = line.qty;
    startTransition(async () => {
      cart?.apply(update);
      if (cart) {
        cart.beginWrite();
        announceCartCount(cart.pieceCount - before + (update.qty ?? 0));
      }
      onApplied?.();
      let result: CartActionResult;
      try {
        result = await action();
      } catch (callError) {
        // A rejected call (offline, a 5xx, a deploy), not a refusal: thrown inside the transition
        // it would replace the whole page with the error screen.
        console.error("[cart] cart line call failed", callError);
        settle();
        rollBack(failedCallMessage(callError, CART_CALL_FAILED_MESSAGE));
        return;
      }
      const last = settle();
      if (!result.ok) {
        rollBack(result.message);
        return;
      }
      // While a later tap is still on its way, the badge keeps showing that tap's count.
      if (last) announceCartCount(result.pieceCount);
      announceCartStatus(done);
    });
  }

  /** True when no other cart write of this page is still on its way. */
  function settle(): boolean {
    return cart ? cart.endWrite() : true;
  }

  // The optimistic values end with the transition (a refusal brings no new render); the header
  // count goes back to the latest count the server rendered.
  function rollBack(message: string) {
    setError(message);
    if (cart) announceCartCount(cart.serverPieceCount());
  }

  // The removed row disappears at once, so focus goes to the page heading instead of falling to
  // <body>.
  const remove = () => {
    if (isPending) return;
    run({ sku: line.sku, qty: null }, () => removeCartItemAction({ sku: line.sku }), `${itemName} dihapus dari keranjang.`, () =>
      document.getElementById(CART_HEADING_ID)?.focus(),
    );
  };
  const setQty = (qty: number) => run({ sku: line.sku, qty }, () => updateCartItemQtyAction({ sku: line.sku, qty }), `Jumlah ${itemName} menjadi ${qty}.`);

  // Raising is refused at the cap and while the line already asks for more than is left; lowering
  // is always allowed (down to 1; × removes).
  const roomForPieces = cart ? cart.pieceCount < CART_MAX_PIECES : canAddPieces;
  const canIncrease = line.status === "ok" && line.qty < CART_MAX_QTY_PER_LINE && roomForPieces;
  const canDecrease = line.qty > 1;

  if (!optimisticLine) return null;

  return (
    <li className="flex gap-4 border-b border-line py-4 first:pt-0" aria-busy={isPending || undefined} data-testid="cart-line">
      <Link href={`/products/${line.productSlug}`} tabIndex={-1} aria-hidden="true" className="relative h-[144px] w-[96px] shrink-0 bg-image-bg">
        <ProductImage
          src={imageUrl}
          alt=""
          placeholderAlt=""
          placeholderSize={800}
          sizes="96px"
          className={cn("object-cover", !buyable && "opacity-50")}
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/products/${line.productSlug}`} className={cn("text-sm", buyable ? "text-ink" : "text-ink-muted")}>
            {line.productName}
          </Link>
          {buyable && (
            <button
              type="button"
              onClick={remove}
              aria-disabled={isPending || undefined}
              aria-label={`Hapus ${itemName}`}
              className="-mt-3 -mr-3 flex size-11 shrink-0 items-center justify-center text-ink hover:text-ink-muted aria-disabled:cursor-wait"
            >
              <X className="size-4" strokeWidth={1.4} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-muted">{variantLabel}</p>
        {buyable && <p className="mt-1 text-sm font-medium text-ink">{formatPriceIdr(line.lineTotal)}</p>}
        {line.status !== "ok" && (
          <p className={cn("mt-1 text-xs", line.status === "insufficient" ? "text-error" : "text-ink-muted")}>{CART_LINE_STATUS_MESSAGES[line.status]}</p>
        )}

        <div className="mt-auto pt-3">
          {buyable ? (
            <div className="inline-flex h-11 items-center border border-line-strong">
              <button
                type="button"
                onClick={() => canDecrease && setQty(line.qty - 1)}
                aria-disabled={!canDecrease || undefined}
                aria-label={`Kurangi jumlah ${itemName}`}
                className={cn("flex size-11 items-center justify-center", canDecrease ? "text-ink" : "cursor-default text-line-strong")}
              >
                <Minus className="size-4" strokeWidth={1.4} aria-hidden="true" />
              </button>
              <span className="w-8 text-center text-sm text-ink tabular-nums" data-testid="cart-line-qty">
                <span className="sr-only">Jumlah </span>
                {line.qty}
              </span>
              <button
                type="button"
                onClick={() => canIncrease && setQty(line.qty + 1)}
                aria-disabled={!canIncrease || undefined}
                aria-label={`Tambah jumlah ${itemName}`}
                className={cn("flex size-11 items-center justify-center", canIncrease ? "text-ink" : "cursor-default text-line-strong")}
              >
                <Plus className="size-4" strokeWidth={1.4} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={remove}
              aria-disabled={isPending || undefined}
              aria-label={`Hapus ${itemName}`}
              className="min-h-11 min-w-11 text-left text-xs font-medium tracking-[0.12em] text-ink uppercase underline underline-offset-4"
            >
              Hapus
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}
