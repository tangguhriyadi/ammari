import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CART_MAX_PIECES, CART_REFUSAL_MESSAGES } from "@ammari/commerce/cart-limits";
import { isCartEnabled } from "@/lib/cart-flag";
import { loadCartView } from "@/lib/cart/queries";
import { loadPendingCheckoutOrder } from "@/lib/checkout/pending-order";
import { buildImageUrl, getStoragePublicBaseUrl } from "@/lib/storage/public-url";
import { Container } from "@/components/container";
import { PrimaryButton, PrimaryLink } from "@/components/buttons";
import { CartLineItem } from "@/components/cart/cart-line-item";
import { PendingOrderBanner } from "@/components/checkout/pending-order-banner";
import { CartLiveRegion } from "@/components/cart/cart-live-region";
import { CartPieceCount, CartSubtotal, OptimisticCartProvider } from "@/components/cart/optimistic-cart";
import { CART_HEADING_ID } from "@/lib/cart/count-event";

// The cart page (docs/plans/cart-checkout.md §4.2, docs/design/storefront.md §7,
// mockup-cart.png). The shipping row says "Dihitung saat checkout", as in the mockup: since the
// owner's 2026-10-21 decision shipping is a Rp20.000 subsidy, not free, and the buyer's share is
// only known once checkout has the destination (plan D11). force-dynamic is required, not just tidy: with the flag off this page calls
// notFound() before touching cookies, so without it `next build` (which runs with the flag off)
// would prerender a static not-found that a runtime flag flip could never replace. With the flag
// on every request re-reads the cart, prices and availability uncached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Keranjang | Ammari",
  robots: { index: false, follow: false },
};

const COLLECTION_HREF = "/#koleksi";

export default async function CartPage() {
  if (!isCartEnabled()) notFound();

  const [cart, pendingOrder] = await Promise.all([loadCartView(), loadPendingCheckoutOrder()]);
  const storageBaseUrl = getStoragePublicBaseUrl();
  const atPieceCap = cart.pieceCount >= CART_MAX_PIECES;
  const showCapNote = atPieceCap || cart.mergeTrimmed;

  // Quantity, line totals, subtotal and the piece count follow a stepper tap at once (optimistic,
  // components/cart/optimistic-cart.tsx); the server's render replaces them.
  return (
    <OptimisticCartProvider lines={cart.lines}>
      <Container className="py-6 md:py-10">
        <div className="flex items-baseline justify-between gap-4">
          {/* Focus target after a line is removed (tabIndex -1: reachable by script, not by Tab). */}
          <h1 id={CART_HEADING_ID} tabIndex={-1} className="font-serif text-[30px] font-normal text-ink outline-none">
            Keranjang
          </h1>
          {cart.lines.length > 0 && (
            <p className="text-xs text-ink-muted">
              <CartPieceCount fallback={cart.pieceCount} />
            </p>
          )}
        </div>

        <CartLiveRegion />

        {pendingOrder && (
          <div className="mt-6">
            <PendingOrderBanner orderNo={pendingOrder.orderNo} payBy={pendingOrder.payBy} paymentUrl={pendingOrder.paymentUrl} />
          </div>
        )}

        {cart.lines.length === 0 ? (
          <div className="flex flex-col items-start gap-6 py-10">
            <p className="text-sm text-ink-muted">Keranjangmu masih kosong.</p>
            <PrimaryLink href={COLLECTION_HREF} className="w-full md:w-auto">
              Lihat koleksi
            </PrimaryLink>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6 md:grid md:grid-cols-[minmax(0,1fr)_360px] md:items-start md:gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
            <ul aria-label="Barang di keranjang" className="flex flex-col">
              {cart.lines.map((line) => (
                <CartLineItem
                  key={line.sku}
                  line={line}
                  imageUrl={line.image ? buildImageUrl(storageBaseUrl, line.image.storageKey, 400) : null}
                  canAddPieces={!atPieceCap}
                />
              ))}
            </ul>

            <section aria-label="Ringkasan keranjang" className="flex flex-col gap-4 md:sticky md:top-20 md:bg-surface md:p-6">
              <dl className="flex flex-col gap-3 text-sm text-ink">
                <div className="flex items-center justify-between gap-4">
                  <dt>Subtotal</dt>
                  <dd className="font-medium" data-testid="cart-subtotal">
                    <CartSubtotal fallback={cart.subtotal} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt>Ongkir</dt>
                  <dd>Dihitung saat checkout</dd>
                </div>
              </dl>

              {showCapNote && (
                <p role="status" className="text-xs text-ink">
                  {CART_REFUSAL_MESSAGES.cart_limit}
                </p>
              )}
              {!cart.canCheckout && (
                <p id="cart-blocked-note" className="text-xs text-error" data-testid="cart-blocked-note">
                  Ubah atau hapus barang yang ditandai untuk lanjut ke checkout.
                </p>
              )}

              {cart.canCheckout ? (
                <PrimaryLink href="/checkout" className="w-full">
                  Lanjut ke checkout
                </PrimaryLink>
              ) : (
                <PrimaryButton disabled aria-describedby="cart-blocked-note" className="w-full">
                  Lanjut ke checkout
                </PrimaryButton>
              )}
              <Link
                href={COLLECTION_HREF}
                className="mx-auto flex min-h-11 items-center text-xs font-medium tracking-[0.18em] text-ink uppercase underline underline-offset-4"
              >
                Lanjut belanja
              </Link>
            </section>
          </div>
        )}
      </Container>
    </OptimisticCartProvider>
  );
}
