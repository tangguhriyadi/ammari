"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Minus, Plus, X } from "lucide-react";
import { cn } from "@ammari/ui";
import type { CartLine } from "@ammari/commerce/cart";
import { CART_LINE_STATUS_MESSAGES, CART_MAX_QTY_PER_LINE } from "@ammari/commerce/cart-limits";
import { removeCartItemAction, updateCartItemQtyAction, type CartActionResult } from "@/lib/cart/actions";
import { announceCartCount, announceCartStatus, CART_CALL_FAILED_MESSAGE, CART_HEADING_ID } from "@/lib/cart/count-event";
import { formatPriceIdr } from "@/lib/format";
import { ProductImage } from "@/components/product-image";

export interface CartLineItemProps {
  line: CartLine;
  /** Resolved on the server (the storage base URL is not a public env var). */
  imageUrl: string | null;
  /** The cart is below the 20-piece cap, so a "+" can still succeed. */
  canAddPieces: boolean;
}

/** One `/cart` line (docs/plans/cart-checkout.md §4.2, docs/design/storefront.md §7). A line that
 * can still be bought has the 1 to 10 stepper and ×; a sold-out or no longer available line shows
 * only its state and "Hapus". Every change goes through a server action, which re-checks stock
 * and the caps; on success the page re-renders from the server (fresh prices and states) and the
 * header count updates. Never shows a stock number.
 *
 * The line stays pending until that re-render has landed (the refresh runs inside the same
 * transition), so a quick second tap can never send a quantity computed from the old one. Pending
 * and boundary states use `aria-disabled` plus a guard instead of `disabled`, so a keyboard user's
 * focus stays on the button they are pressing. */
export function CartLineItem({ line, imageUrl, canAddPieces }: CartLineItemProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const buyable = line.status === "ok" || line.status === "insufficient";
  const variantLabel = `${line.colorName} · ${line.sizeLabel}`;
  const itemName = `${line.productName}, ${line.colorName}, ${line.sizeLabel}`;

  function run(action: () => Promise<CartActionResult>, done: string, onDone?: () => void) {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      let result: CartActionResult;
      try {
        result = await action();
      } catch (callError) {
        // A rejected call (offline, a 5xx, a deploy), not a refusal: thrown inside the transition
        // it would replace the whole page with the error screen.
        console.error("[cart] cart line call failed", callError);
        setError(CART_CALL_FAILED_MESSAGE);
        return;
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      announceCartCount(result.pieceCount);
      announceCartStatus(done);
      startTransition(() => router.refresh());
      onDone?.();
    });
  }

  // The removed row unmounts, so focus goes to the page heading instead of falling to <body>.
  const remove = () =>
    run(() => removeCartItemAction({ sku: line.sku }), `${itemName} dihapus dari keranjang.`, () => document.getElementById(CART_HEADING_ID)?.focus());
  const setQty = (qty: number) => run(() => updateCartItemQtyAction({ sku: line.sku, qty }), `Jumlah ${itemName} menjadi ${qty}.`);

  // Raising is refused at the cap and while the line already asks for more than is left; lowering
  // is always allowed (down to 1; × removes).
  const canIncrease = line.status === "ok" && line.qty < CART_MAX_QTY_PER_LINE && canAddPieces;
  const canDecrease = line.qty > 1;

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
                aria-disabled={isPending || !canDecrease || undefined}
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
                aria-disabled={isPending || !canIncrease || undefined}
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
