"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { cn } from "@ammari/ui";
import { getGalleryForColor, type ProductView } from "@/lib/content/product-view";
import { buildImageUrl } from "@/lib/storage/public-url";
import { formatPriceIdr } from "@/lib/format";
import { buildProductWhatsappMessage, buildWhatsappUrl } from "@/lib/whatsapp";
import { PrimaryButton, PrimaryLink, OutlineLink } from "@/components/buttons";
import { ProductImage } from "@/components/product-image";

export interface ProductPurchasePanelProps {
  view: ProductView;
  initialColorId: string | null;
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
   * just flows through, never re-rendered by THIS component). Lives inside the sticky right
   * column, next to the gallery, rather than breaking out full-width below the two-column area —
   * otherwise the tall stacked gallery on desktop leaves a large dead gap next to a much shorter
   * info column (docs/design/storefront.md §6: "right a sticky info column"). */
  afterActions: ReactNode;
}

/** docs/design/storefront.md §6 items 1–6 — gallery, name/price, colour swatches, size grid, and
 * the primary action(s). One client component because all of it shares state: picking a colour
 * changes the gallery AND resets the size selection AND updates `?color=` in the URL (replace,
 * not push, per the spec). Mobile: horizontal swipe gallery with a "N / total" chip. Desktop: a
 * vertical stack, both columns sticky (docs/design/storefront.md §6: "left a vertical stack of
 * images ... right a sticky info column"). */
export function ProductPurchasePanel({ view, initialColorId, cartEnabled, whatsappNumber, pageUrl, storageBaseUrl, afterActions }: ProductPurchasePanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [colorId, setColorId] = useState(initialColorId);
  const [size, setSize] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);

  const selectedColor = view.colors.find((color) => color.id === colorId) ?? null;
  // Never empty while the product has any photo (see getGalleryForColor's fallback chain); a
  // product with none renders one placeholder slide instead (`null` src), never a blank column.
  const gallery = getGalleryForColor(view, colorId);
  const slides: { key: string; src: string | null; alt: string }[] =
    gallery.length > 0
      ? gallery.map((image) => ({ key: image.id, src: buildImageUrl(storageBaseUrl, image.storageKey, 1600), alt: image.altText }))
      : [{ key: "placeholder", src: null, alt: view.name }];

  // Scrolls the gallery back to its first image whenever the selected colour changes (a new
  // image array) — updating the DOM (an external system) and the matching counter state
  // together is exactly what this effect is for, not a mirror of state React already owns.
  useEffect(() => {
    scrollRef.current?.scrollTo({ left: 0 });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGalleryIndex(0);
  }, [colorId]);

  function handleSelectColor(id: string) {
    if (id === colorId) return;
    setColorId(id);
    setSize(null);
    setAdded(false);
    const params = new URLSearchParams(window.location.search);
    params.set("color", id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function handleGalleryScroll() {
    const el = scrollRef.current;
    if (!el || el.clientWidth === 0) return;
    setGalleryIndex(Math.round(el.scrollLeft / el.clientWidth));
  }

  const sizeOptions = colorId ? (view.sizeOptionsByColor?.[colorId] ?? []) : [];
  const allsizeAvailable = colorId ? (view.allsizeAvailableByColor?.[colorId] ?? false) : false;
  const needsSizeChoice = view.sizeMode === "sized" && !size;

  const whatsappMessage = buildProductWhatsappMessage({
    productName: view.name,
    colorName: selectedColor?.name ?? "",
    size,
    url: pageUrl,
  });
  const whatsappHref = whatsappNumber ? buildWhatsappUrl(whatsappNumber, whatsappMessage) : null;

  return (
    <div className="flex flex-col gap-6 md:grid md:grid-cols-2 md:items-start md:gap-10">
      <div className="flex flex-col gap-2">
        {/* Mobile: horizontal swipe gallery */}
        <div className="relative md:hidden">
          <div ref={scrollRef} onScroll={handleGalleryScroll} className="flex snap-x snap-mandatory overflow-x-auto">
            {slides.map((slide, index) => (
              <div key={slide.key} className="relative aspect-[2/3] w-full shrink-0 snap-center bg-image-bg">
                <ProductImage src={slide.src} alt={slide.alt} placeholderAlt={`Foto ${view.name} belum tersedia`} placeholderSize={1600} priority={index === 0} sizes="100vw" className="object-cover" />
              </div>
            ))}
          </div>
          {gallery.length > 0 && (
            <span className="absolute right-3 bottom-3 bg-bg px-2 py-1 text-xs text-ink">
              {galleryIndex + 1} / {gallery.length}
            </span>
          )}
        </div>

        {/* Desktop: vertical stack, sticky */}
        <div className="hidden md:sticky md:top-20 md:flex md:flex-col md:gap-2">
          {slides.map((slide, index) => (
            <div key={slide.key} className="relative aspect-[2/3] w-full bg-image-bg">
              <ProductImage src={slide.src} alt={slide.alt} placeholderAlt={`Foto ${view.name} belum tersedia`} placeholderSize={1600} priority={index === 0} sizes="50vw" className="object-cover" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6 md:sticky md:top-20">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-[30px] font-normal text-ink">{view.name}</h1>
          <p className="text-[17px] font-medium text-ink">{formatPriceIdr(view.basePrice)}</p>
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
              <a href="#ukuran" className="text-xs text-ink underline underline-offset-4">
                Panduan ukuran
              </a>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {sizeOptions.map((option) => (
                <button
                  key={option.size}
                  type="button"
                  disabled={!option.available}
                  onClick={() => {
                    setSize(option.size);
                    setAdded(false);
                  }}
                  aria-label={option.available ? option.size : `${option.size}, habis`}
                  className={cn(
                    "flex h-[46px] items-center justify-center border text-xs",
                    option.size === size ? "border-ink bg-ink text-white" : "border-line-strong text-ink",
                    !option.available && "text-ink-muted line-through disabled:cursor-not-allowed",
                  )}
                >
                  {option.size}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {cartEnabled && (
            <>
              <PrimaryButton disabled={needsSizeChoice || (view.sizeMode === "all_size" && !allsizeAvailable)} onClick={() => setAdded(true)}>
                {needsSizeChoice ? "Pilih ukuran" : "Tambah ke keranjang"}
              </PrimaryButton>
              {added && selectedColor && (
                <p className="bg-surface px-4 py-3 text-xs text-ink">
                  Masuk keranjang: {selectedColor.name}
                  {size ? `, ${size}` : ""}
                </p>
              )}
            </>
          )}
          {whatsappHref &&
            (cartEnabled ? (
              <OutlineLink href={whatsappHref} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="size-4" strokeWidth={1.4} aria-hidden="true" />
                Tanya via WhatsApp
              </OutlineLink>
            ) : (
              <PrimaryLink href={whatsappHref} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="size-4" strokeWidth={1.4} aria-hidden="true" />
                Tanya via WhatsApp
              </PrimaryLink>
            ))}
        </div>

        {afterActions}
      </div>
    </div>
  );
}
