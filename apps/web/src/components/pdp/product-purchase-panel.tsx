"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { cn } from "@ammari/ui";
import { buildProductGallery, type ProductView } from "@/lib/content/product-view";
import { buildProductWhatsappMessage, buildWhatsappUrl } from "@/lib/whatsapp";
import { addToCartAction, buyNowAction } from "@/lib/cart/actions";
import { announceCartCount, CART_CALL_FAILED_MESSAGE, liveRegionText } from "@/lib/cart/count-event";
import { CART_REFUSAL_MESSAGES } from "@ammari/commerce/cart-limits";
import { OutlineButton, PrimaryButton, PrimaryLink, SoldOutButton } from "@/components/buttons";
import { PendingOrderNotice } from "@/components/pdp/pending-order-notice";
import { OPEN_ACCORDION_EVENT, SIZE_CHART_HEADING_ID, SIZE_GUIDE_ACCORDION_ID, type OpenAccordionDetail } from "@/components/pdp/size-guide";
import { ProductGallery, type ProductGalleryHandle } from "@/components/pdp/product-gallery";
import { ProductPrice } from "@/components/product-price";
import { Curtain } from "@/components/curtain";
import { failedCallMessage } from "@/lib/stale-deployment";

export interface ProductPurchasePanelProps {
  view: ProductView;
  initialColorId: string | null;
  /** `initialGalleryIndex(view, buildProductGallery(view), ?color=)`, computed by the page so the
   * first paint already shows the right photo (docs/plans/pdp-gallery.md §3.1). */
  initialGalleryIndex: number;
  cartEnabled: boolean;
  whatsappNumber: string | null;
  pageUrl: string;
  /** Resolved server-side (lib/storage/public-url.ts's `getStoragePublicBaseUrl()`) and passed
   * down as a plain string — `STORAGE_PUBLIC_BASE_URL` is deliberately not a `NEXT_PUBLIC_` var
   * (see that module's own doc comment), so this Client Component can't read it itself. */
  storageBaseUrl: string;
  /** Trust row / Keunggulan / accordions — server-rendered in page.tsx and passed through as a
   * slot (the standard RSC "children from a Server Component into a Client Component" pattern:
   * `Accordions` inside is itself a Client Component, but it's constructed server-side here and
   * just flows through, never re-rendered by THIS component). Lives in the right column, next to
   * the sticky gallery, rather than breaking out full-width below the two-column area. */
  afterActions: ReactNode;
}

/** docs/design/storefront.md §6 items 1–6 — gallery, name/price, colour swatches, size grid, and
 * the primary action(s). One client component because all of it shares state: picking a colour
 * jumps the gallery to that colour's photos AND resets the size selection AND updates `?color=`
 * in the URL (replace, not push, per the spec). The gallery (product-gallery.tsx) owns which
 * photo shows and is sticky on desktop; the info column scrolls (docs/plans/pdp-gallery.md §3.1). */
export function ProductPurchasePanel({ view, initialColorId, initialGalleryIndex, cartEnabled, whatsappNumber, pageUrl, storageBaseUrl, afterActions }: ProductPurchasePanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const galleryRef = useRef<ProductGalleryHandle>(null);

  const [colorId, setColorId] = useState(initialColorId);
  const [size, setSize] = useState<string | null>(null);
  // Cart (flag on only). `addedLabel` outlives `showAdded` so the "Masuk keranjang" box keeps its
  // text while the curtain rolls it back up.
  const [showAdded, setShowAdded] = useState(false);
  const [addedLabel, setAddedLabel] = useState("");
  const [cartMessage, setCartMessage] = useState<{ text: string; isError: boolean } | null>(null);
  // Screen-reader confirmation of every successful add (count included), in an always-mounted
  // status region; the sequence makes a repeat of the same text announce again.
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  const [isAdding, startAdding] = useTransition();
  const [isBuying, startBuying] = useTransition();
  // Stays true once the browser is on its way to /checkout, so a second tap does nothing.
  const [leavingForCheckout, setLeavingForCheckout] = useState(false);
  const cartBusy = isAdding || isBuying || leavingForCheckout;
  // Back on this page (the back button, the bfcache) or a navigation that never happened: the
  // buttons work again.
  useEffect(() => {
    if (!leavingForCheckout) return;
    const reset = () => setLeavingForCheckout(false);
    const timer = window.setTimeout(reset, 10_000);
    const onPageShow = (event: PageTransitionEvent) => event.persisted && reset();
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [leavingForCheckout]);
  // The colour/size the buyer has selected right now, read when an add resolves: if they moved on
  // meanwhile, the box must not name a variant other than the one on screen.
  const selectionRef = useRef("");

  function resetCartFeedback() {
    setShowAdded(false);
    setCartMessage(null);
  }

  const selectedColor = view.colors.find((color) => color.id === colorId) ?? null;
  // Every photo of the product, the same list (and indexes) the page computed its initial index
  // from. `view` never changes on the client, so neither does this.
  const [gallery] = useState(() => buildProductGallery(view));

  function handleSelectColor(id: string) {
    // Before the early return: re-tapping the selected colour jumps back to its first photo too
    // (docs/plans/pdp-gallery.md §13 #4).
    galleryRef.current?.showColor(id);
    if (id === colorId) return;
    setColorId(id);
    setSize(null);
    resetCartFeedback();
    const params = new URLSearchParams(window.location.search);
    params.set("color", id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const sizeOptions = colorId ? (view.sizeOptionsByColor?.[colorId] ?? []) : [];
  const allsizeAvailable = colorId ? (view.allsizeAvailableByColor?.[colorId] ?? false) : false;
  // Nothing buyable: the whole product has no stock, or the selected colour has none (sized:
  // every offered size is habis or there are none; all_size: its one variant is habis).
  const colorSoldOut = view.sizeMode === "sized" ? sizeOptions.every((option) => !option.available) : !allsizeAvailable;
  const soldOut = view.soldOut || colorSoldOut;
  const needsSizeChoice = view.sizeMode === "sized" && !size;
  const selectedSku =
    view.sizeMode === "sized"
      ? (sizeOptions.find((option) => option.size === size && option.available)?.sku ?? null)
      : colorId
        ? (view.allsizeSkuByColor?.[colorId] ?? null)
        : null;

  const selectionLabel = `${selectedColor?.name ?? ""}${size ? `, ${size}` : ""}`;
  useEffect(() => {
    selectionRef.current = selectionLabel;
  });

  // One piece per tap. The server decides everything (active/published, stock, the 10 per line
  // and 20 per cart caps) and answers with a message on refusal; nothing here is trusted. A call
  // that rejects outright (offline, a 5xx, a deploy) is caught here: thrown inside a transition
  // it would otherwise replace the whole page with the error screen.
  function handleAddToCart() {
    if (!selectedSku || cartBusy) return;
    const label = selectionLabel;
    startAdding(async () => {
      let result: Awaited<ReturnType<typeof addToCartAction>>;
      try {
        result = await addToCartAction({ sku: selectedSku, qty: 1 });
      } catch (error) {
        console.error("[cart] add to cart call failed", error);
        setShowAdded(false);
        setCartMessage({ text: failedCallMessage(error, CART_CALL_FAILED_MESSAGE), isError: true });
        return;
      }
      if (!result.ok) {
        setShowAdded(false);
        setCartMessage({ text: result.message, isError: true });
        return;
      }
      announceCartCount(result.pieceCount);
      const trimmedNote = result.mergeTrimmed ? CART_REFUSAL_MESSAGES.cart_limit : null;
      setAnnouncement((previous) => ({
        text: `Masuk keranjang: ${label}. ${result.pieceCount} barang di keranjang.${trimmedNote ? ` ${trimmedNote}` : ""}`,
        sequence: previous.sequence + 1,
      }));
      // Still the same selection: confirm it on screen. Otherwise only the count changes.
      if (selectionRef.current === label) {
        setAddedLabel(label);
        setShowAdded(true);
        setCartMessage(trimmedNote ? { text: trimmedNote, isError: false } : null);
      }
    });
  }

  // "Beli sekarang" (flag on, owner request 2026-10-21): the selected size goes into the cart (one
  // piece, never a second one when it is already there) and the buyer goes straight to /checkout,
  // which checks out the whole cart: every line is shown there before paying, and nothing else
  // about the cart changes (owner decision: the simpler, safe option over a one-item checkout).
  function handleBuyNow() {
    if (!selectedSku || cartBusy) return;
    startBuying(async () => {
      let result: Awaited<ReturnType<typeof buyNowAction>>;
      try {
        result = await buyNowAction({ sku: selectedSku });
      } catch (error) {
        console.error("[cart] buy now call failed", error);
        setShowAdded(false);
        setCartMessage({ text: failedCallMessage(error, CART_CALL_FAILED_MESSAGE), isError: true });
        return;
      }
      if (!result.ok) {
        setShowAdded(false);
        setCartMessage({ text: result.message, isError: true });
        return;
      }
      announceCartCount(result.pieceCount);
      setLeavingForCheckout(true);
      router.push("/checkout");
    });
  }

  const whatsappMessage = buildProductWhatsappMessage({
    productName: view.name,
    colorName: selectedColor?.name ?? "",
    size,
    url: pageUrl,
  });
  const whatsappHref = whatsappNumber ? buildWhatsappUrl(whatsappNumber, whatsappMessage) : null;

  return (
    <div className="flex flex-col gap-6 md:grid md:grid-cols-2 md:items-start md:gap-10">
      <ProductGallery ref={galleryRef} productName={view.name} gallery={gallery} initialIndex={initialGalleryIndex} storageBaseUrl={storageBaseUrl} />

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-[30px] font-normal text-ink">{view.name}</h1>
          <ProductPrice price={view.price} className="text-[17px] font-medium" />
        </div>

        {view.colors.length > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink">Warna{selectedColor ? `: ${selectedColor.name}` : ""}</p>
            <div className="flex flex-wrap gap-3">
              {view.colors.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() => handleSelectColor(color.id)}
                  aria-label={color.name}
                  aria-pressed={color.id === colorId}
                  className={cn(
                    "flex size-11 items-center justify-center rounded-full",
                    color.id === colorId ? "ring-1 ring-ink ring-offset-2" : "",
                  )}
                >
                  <span className="size-full rounded-full border-4 border-bg outline outline-1 outline-line-strong" style={{ backgroundColor: color.hex ?? undefined }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {view.sizeMode === "sized" && sizeOptions.length > 0 && (
          <div id="ukuran-picker" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink">Ukuran{size ? `: ${size}` : ""}</p>
              {/* Only when there is a chart to land on (the heading lives in SizeChartTable). */}
              {view.sizeChart && view.sizeChart.length > 0 && (
                <a
                  href={`#${SIZE_GUIDE_ACCORDION_ID}`}
                  onClick={(event) => {
                    // Leave new-tab / modified clicks to the browser (plain `#ukuran` link).
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                    event.preventDefault();
                    window.dispatchEvent(
                      new CustomEvent<OpenAccordionDetail>(OPEN_ACCORDION_EVENT, { detail: { accordionId: SIZE_GUIDE_ACCORDION_ID, targetId: SIZE_CHART_HEADING_ID } }),
                    );
                  }}
                  className="text-xs text-ink underline underline-offset-4"
                >
                  Panduan ukuran
                </a>
              )}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {sizeOptions.map((option) => (
                <button
                  key={option.size}
                  type="button"
                  aria-disabled={!option.available}
                  onClick={() => {
                    if (!option.available) return;
                    setSize(option.size);
                    resetCartFeedback();
                  }}
                  aria-label={option.available ? option.size : `Ukuran ${option.size} habis`}
                  aria-pressed={option.size === size}
                  className={cn(
                    "flex h-[46px] items-center justify-center border text-xs",
                    option.available
                      ? option.size === size
                        ? "border-ink bg-ink text-white"
                        : "border-line-strong text-ink"
                      : "cursor-not-allowed border-line bg-surface text-ink-muted line-through",
                  )}
                >
                  {option.size}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {/* The visitor's own order waiting for payment, when it holds this product (fetched
              after load: this page is shared and cached). */}
          {cartEnabled && <PendingOrderNotice productId={view.id} />}
          {soldOut && <SoldOutButton />}
          {cartEnabled && !soldOut && (
            <>
              {/* While a call is in flight the buttons stay focusable (aria-disabled, not disabled)
                  and say so; further taps are ignored by the handlers. */}
              <PrimaryButton
                disabled={needsSizeChoice}
                aria-disabled={cartBusy || undefined}
                onClick={handleBuyNow}
                className={cn((isBuying || leavingForCheckout) && "cursor-wait opacity-80")}
              >
                {needsSizeChoice ? "Pilih ukuran" : isBuying || leavingForCheckout ? "Memproses" : "Beli sekarang"}
              </PrimaryButton>
              <OutlineButton
                disabled={needsSizeChoice}
                aria-disabled={cartBusy || undefined}
                onClick={handleAddToCart}
                className={cn(isAdding && "cursor-wait opacity-80")}
              >
                {isAdding ? "Menambahkan" : "Tambah ke keranjang"}
              </OutlineButton>
              <Curtain open={showAdded} contentClassName="flex items-center bg-surface pl-4 text-xs text-ink">
                <p>
                  Masuk keranjang: {addedLabel} ·{" "}
                  <Link href="/cart" className="inline-flex min-h-11 items-center px-1 underline underline-offset-4">
                    Lihat
                  </Link>
                </p>
              </Curtain>
              <p role="status" className="sr-only">
                {liveRegionText(announcement.text, announcement.sequence)}
              </p>
              {cartMessage &&
                (cartMessage.isError ? (
                  <p role="alert" className="text-xs text-error">
                    {cartMessage.text}
                  </p>
                ) : (
                  <p className="text-xs text-ink">{cartMessage.text}</p>
                ))}
            </>
          )}
          {/* With the cart off the WhatsApp button is the main CTA (sold out, that slot is the
              SOLD OUT button above); with it on, a small text link under the buttons. */}
          {whatsappHref &&
            (cartEnabled ? (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mx-auto inline-flex min-h-11 items-center gap-2 text-xs text-ink underline underline-offset-4"
              >
                <MessageCircle className="size-4" strokeWidth={1.4} aria-hidden="true" />
                Tanya via WhatsApp
              </a>
            ) : (
              !soldOut && (
                <PrimaryLink href={whatsappHref} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="size-4" strokeWidth={1.4} aria-hidden="true" />
                  Tanya via WhatsApp
                </PrimaryLink>
              )
            ))}
        </div>

        {afterActions}
      </div>
    </div>
  );
}
