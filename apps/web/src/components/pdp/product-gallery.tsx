"use client";

import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { ChevronLeft, ChevronRight, ZoomIn } from "lucide-react";
import { cn } from "@ammari/ui";
import type { ProductGallery, ProductGalleryItem } from "@/lib/content/product-view";
import { colorJumpIndex, nextIndex, prevIndex } from "@/lib/gallery/index-math";
import { GALLERY_SLIDE_EASING, GALLERY_SLIDE_MS, SWIPE_CLICK_CANCEL_PX, swipeDirection } from "@/lib/gallery/swipe";
import { buildImageSrcSet, buildImageUrl } from "@/lib/storage/public-url";
import { liveRegionText } from "@/lib/cart/count-event";
import { ProductImage } from "@/components/product-image";

/** What the purchase panel may do to the gallery: show a colour's photos. Nothing flows back: the
 * gallery gets no colour setter at all, so browsing can never change the colour (owner decision 3,
 * docs/plans/pdp-gallery.md §8). */
export interface ProductGalleryHandle {
  /** Jumps to the colour's first photo (or the first general photo when it has none) and scrolls
   * the strip to it. Also on a re-tap of the selected colour (§13 #4). */
  showColor: (colorId: string) => void;
}

export interface ProductGalleryProps {
  productName: string;
  gallery: ProductGallery;
  /** Server-computed (`initialGalleryIndex`), so the first paint already shows the right photo. */
  initialIndex: number;
  /** See ProductPurchasePanelProps.storageBaseUrl. */
  storageBaseUrl: string;
  /** Called with the current index when the shopper clicks the main image. Placeholder until the
   * full-screen viewer lands (docs/plans/pdp-gallery.md §11, session 3). */
  onOpenViewer?: (index: number) => void;
  ref?: Ref<ProductGalleryHandle>;
}

// The main photo is ~40% of the viewport from md up (two columns, capped by the viewport height),
// full width on phones. 800 suits a 2x phone, 1600 a 3x phone or a desktop.
const MAIN_SIZES = "(min-width: 768px) 40vw, 100vw";
const MAIN_FILES = [800, 1600] as const;
// The strip's padding (p-1): room for the active outline and the focus ring inside its overflow.
const STRIP_PADDING_PX = 4;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Elements whose own Left/Right keys must win over the page-wide photo keys (§3.1, owner
 * feedback 2026-10-23): text entry, widgets that use arrow keys themselves, and anything that
 * scrolls sideways (the size chart table). */
const OWN_ARROW_KEYS = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='spinbutton'], [role='scrollbar'], [role='listbox'], [role='combobox'], [role='menu'], [role='menubar'], [role='toolbar'], [role='radiogroup'], [role='tablist'], [role='grid'], [role='tree'], [role='treegrid']";

function keepsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(OWN_ARROW_KEYS) || (target instanceof HTMLElement && target.isContentEditable)) return true;
  for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
    const overflowX = getComputedStyle(element).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth) return true;
  }
  return false;
}

/** A drag in progress on the main image. Refs, not state: only the offset needs a re-render. */
interface DragTrack {
  pointerId: number;
  startX: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/** The track follows the finger: shifted by `offset` px, with the neighbour on `side` (`1` =
 * next, `-1` = previous) peeking in. */
interface DragState {
  offset: number;
  side: -1 | 0 | 1;
}

/** One slide of the track from `from` to rest (Web Animations), with `others` (the photo leaving,
 * or the neighbour a snap-back hides again) beside the current one meanwhile. `direction`: `1` =
 * the new photo comes in from the right, `-1` = from the left, `0` = snap back. */
interface Motion {
  id: number;
  from: string;
  /** Photos beside the current one while it slides: the one leaving, and on an interrupted slide
   * the one that was still leaving before it (so no gap opens up). Position in widths. */
  others: { index: number; position: number }[];
  direction: -1 | 0 | 1;
}

/** The PDP photo gallery (docs/plans/pdp-gallery.md §3.1, §3.2, §7): one main 2:3 photo with a
 * counter and a magnifier, a thumbnail strip of every photo (general first, then each colour's
 * group), prev/next arrows on desktop (hover and keyboard focus only), swipe on phones, Left/Right
 * anywhere on the page. Every change slides the photo in from the side it comes from (next and
 * wrap-around from the right, previous from the left, a jump toward the target's side), straight
 * to the target. Only the main photo loads eagerly; thumbnails use the 400 file, lazily (their
 * placeholder is the smallest one, 800). */
export function ProductGallery({ productName, gallery, initialIndex, storageBaseUrl, onOpenViewer, ref }: ProductGalleryProps) {
  const images = gallery.images;
  const count = images.length;
  const [index, setIndex] = useState(() => (Number.isInteger(initialIndex) ? Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0)) : 0));
  const [drag, setDrag] = useState<DragState | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  // The thumbnail that holds the strip's one tab stop while arrow keys move focus (roving
  // tabindex); `null` = the active thumbnail holds it.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  // Polite announcement of user-driven changes only (never the first render or a colour jump);
  // the sequence makes a repeat of the same text announce again.
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });

  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<DragTrack | null>(null);
  const suppressClickRef = useRef(false);
  const motionIdRef = useRef(0);
  const warmedRef = useRef(new Set<string>());

  // Runs the slide once its frames (`other` beside the current photo) are in the DOM, before the
  // browser paints them at rest. A newer slide cancels this one in the cleanup: the latest target
  // always wins, nothing queues.
  useLayoutEffect(() => {
    if (!motion) return;
    const id = motion.id;
    const finish = () => setMotion((current) => (current?.id === id ? null : current));
    const track = trackRef.current;
    if (!track || typeof track.animate !== "function") {
      const timer = window.setTimeout(finish, 0);
      return () => window.clearTimeout(timer);
    }
    const animation = track.animate([{ transform: motion.from }, { transform: "translateX(0)" }], { duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING });
    animation.onfinish = finish;
    return () => animation.cancel();
  }, [motion]);

  // Landing on a colour's photo (`?color=`): bring its thumbnail into view once, after mount.
  // Only the strip's own scroll position changes, never the page's or any layout.
  useEffect(() => {
    revealThumb(index, "start", "auto");
    // Mount only: later changes reveal the thumbnail from the handler that made them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Left/Right anywhere on the page: previous/next photo. Not with a modifier (browser
  // shortcuts), not where the keys already mean something (see keepsArrowKeys), not while a
  // dialog (the session 3 viewer) is open, and not when something already handled the key (the
  // thumbnail strip moves its focus with them instead: one move per key press, never two).
  const handlePageKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (count < 2 || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // A finger or mouse still holding the photo owns it until release.
    if (dragRef.current || document.querySelector("dialog[open], [aria-modal='true']") || keepsArrowKeys(event.target)) return;
    event.preventDefault();
    step(event.key === "ArrowRight" ? 1 : -1);
  });

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handlePageKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useImperativeHandle(ref, () => ({
    showColor(colorId: string) {
      goTo(colorJumpIndex(gallery, colorId, index), { announce: false, align: "start" });
    },
  }));

  function mainSrc(image: ProductGalleryItem): string {
    return buildImageUrl(storageBaseUrl, image.storageKey, 1600);
  }

  function mainSrcSet(image: ProductGalleryItem): string {
    return buildImageSrcSet(storageBaseUrl, image.storageKey, MAIN_FILES);
  }

  /** Scrolls the strip (never the page: no scrollIntoView) so thumbnail `target` is visible;
   * `"start"` puts it at the left edge, so a colour's whole group comes into view. */
  function revealThumb(target: number, align: "nearest" | "start" = "nearest", behavior?: ScrollBehavior) {
    const strip = stripRef.current;
    const thumb = thumbRefs.current[target];
    if (!strip || !thumb) return;
    const left = thumb.offsetLeft - STRIP_PADDING_PX;
    const right = thumb.offsetLeft + thumb.offsetWidth + STRIP_PADDING_PX;
    let scrollLeft: number;
    if (align === "start" || left < strip.scrollLeft) scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) scrollLeft = right - strip.clientWidth;
    else return;
    strip.scrollTo({ left: Math.max(0, scrollLeft), behavior: behavior ?? (prefersReducedMotion() ? "auto" : "smooth") });
  }

  /** Fetches the photos either side of `around` in the size the main image will pick (same
   * srcset and sizes), so the next swipe or arrow press shows a loaded photo. */
  function warmNeighbours(around: number) {
    if (count < 2) return;
    for (const neighbour of [nextIndex(around, count), prevIndex(around, count)]) {
      const image = images[neighbour];
      if (!image || warmedRef.current.has(image.id)) continue;
      warmedRef.current.add(image.id);
      const preload = new Image();
      preload.sizes = MAIN_SIZES;
      preload.srcset = mainSrcSet(image);
      preload.src = mainSrc(image);
    }
  }

  /** Where a slide still running has the track right now (px), so an interrupting slide starts
   * from there instead of jumping: the photo on screen keeps its place. */
  function trackOffsetNow(): number {
    const track = trackRef.current;
    if (!motion || !track || typeof DOMMatrixReadOnly === "undefined") return 0;
    const transform = getComputedStyle(track).transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0;
  }

  /** The only way the photo changes. Never touches colour, size, URL or purchase state. Slides in
   * from `direction` (default: toward the target's side of the list), or from `from` when a swipe
   * hands over the track mid-way; instant under reduced motion. */
  function goTo(
    target: number,
    { announce = true, align = "nearest", direction, from }: { announce?: boolean; align?: "nearest" | "start"; direction?: -1 | 1; from?: string } = {},
  ) {
    const side = direction ?? Math.sign(target - index);
    if (target !== index && side !== 0 && !prefersReducedMotion()) {
      motionIdRef.current += 1;
      const leaving = side === 1 ? -1 : 1;
      setMotion({
        id: motionIdRef.current,
        from: from ?? `translateX(calc(${side * 100}% + ${trackOffsetNow()}px))`,
        // An interrupted slide's own leaving photo keeps its place next to the one on screen.
        others: [{ index, position: leaving }, ...(motion?.others ?? []).map((other) => ({ index: other.index, position: leaving + other.position }))].filter(
          // Only on the leaving side, and only what can still be on screen (a held key chains
          // interrupts). After a reversal the old leaving photo sits where the new one comes in:
          // the new photo covers that place, so it goes.
          (other) => Math.sign(other.position) === leaving && Math.abs(other.position) <= 2,
        ),
        direction: side === 1 ? 1 : -1,
      });
    } else if (target !== index) {
      setMotion(null);
    }
    dragRef.current = null;
    setDrag(null);
    setIndex(target);
    if (announce) setAnnouncement((previous) => ({ text: `Foto ${target + 1} dari ${count}`, sequence: previous.sequence + 1 }));
    revealThumb(target, align);
    warmNeighbours(target);
  }

  /** Next (`1`) or previous (`-1`) photo, wrapping: the last photo's "next" still comes in from
   * the right, never a rewind across the whole list. */
  function step(direction: -1 | 1) {
    goTo(direction === 1 ? nextIndex(index, count) : prevIndex(index, count), { direction });
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (count < 2 || (event.pointerType === "mouse" && event.button !== 0)) return;
    // A new drag takes over from a slide still running: it lands at rest under the finger. A
    // plain tap that stops a slide is not a tap on the photo either (no viewer).
    suppressClickRef.current = motion !== null;
    setMotion(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0 };
    warmNeighbours(index);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const track = dragRef.current;
    if (!track || track.pointerId !== event.pointerId) return;
    const elapsed = event.timeStamp - track.lastTime;
    if (elapsed > 0) track.velocity = (event.clientX - track.lastX) / elapsed;
    track.lastX = event.clientX;
    track.lastTime = event.timeStamp;
    const offset = event.clientX - track.startX;
    if (Math.abs(offset) > SWIPE_CLICK_CANCEL_PX) suppressClickRef.current = true;
    setDrag({ offset, side: offset < 0 ? 1 : offset > 0 ? -1 : 0 });
  }

  function handlePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const track = dragRef.current;
    if (!track || track.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const offset = event.type === "pointercancel" ? 0 : event.clientX - track.startX;
    // A finger that stopped before lifting has no flick left in it.
    const velocity = event.timeStamp - track.lastTime > 100 ? 0 : track.velocity;
    const width = event.currentTarget.clientWidth;
    const direction = swipeDirection(offset, width, velocity);

    if (direction === 0) {
      const side = drag?.side ?? 0;
      setDrag(null);
      // Snap back with the same slide as every other change; the neighbour slides out again.
      if (side !== 0 && offset !== 0 && !prefersReducedMotion()) {
        motionIdRef.current += 1;
        setMotion({ id: motionIdRef.current, from: `translateX(${offset}px)`, others: [{ index: side === 1 ? nextIndex(index, count) : prevIndex(index, count), position: side }], direction: 0 });
      }
      return;
    }
    // Carry on from where the finger left the track: the incoming photo sits `offset` px short
    // of the edge it comes from.
    goTo(direction === 1 ? nextIndex(index, count) : prevIndex(index, count), { direction, from: `translateX(${offset + direction * width}px)` });
  }

  function handleMainClick(event: MouseEvent<HTMLButtonElement>) {
    // The click that ends a swipe is not a tap. A touch swipe fires no click at all, so the flag
    // only ever applies to a pointer click (`detail > 0`), never to Enter/Space later on.
    const endsSwipe = suppressClickRef.current && event.detail > 0;
    suppressClickRef.current = false;
    // Mid-slide: no viewer at a photo that is still moving in.
    if (endsSwipe || motion) return;
    onOpenViewer?.(index);
  }

  function handleStripKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Leave browser shortcuts (Alt+Left = back, Cmd+Home...) alone.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = focusIndex ?? index;
    const to =
      event.key === "ArrowRight"
        ? nextIndex(from, count)
        : event.key === "ArrowLeft"
          ? prevIndex(from, count)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (to === null) return;
    // Also tells the page-wide Left/Right handler that this key is taken.
    event.preventDefault();
    setFocusIndex(to);
    thumbRefs.current[to]?.focus({ preventScroll: true });
    revealThumb(to);
  }

  if (count === 0) {
    return (
      <div className="md:sticky md:top-20">
        <div data-testid="gallery-current" className="relative aspect-[2/3] w-full bg-image-bg">
          <ProductImage src={null} alt={productName} placeholderAlt={`Foto ${productName} belum tersedia`} placeholderSize={1600} fetchPriority="high" sizes={MAIN_SIZES} className="object-cover" />
        </div>
      </div>
    );
  }

  const current = images[index] ?? images[0]!;
  const others = drag
    ? drag.side === 0
      ? []
      : [{ index: drag.side === 1 ? nextIndex(index, count) : prevIndex(index, count), position: drag.side }]
    : (motion?.others ?? []);
  // Keyed by image id: the photo sliding in keeps its DOM node (and loaded file) when it comes to
  // rest, and a swipe's neighbour becomes the current photo in place, so nothing flashes. A photo
  // shows once (the first place wins); anything more than two widths away is off screen anyway.
  const slots = [{ image: current, position: 0 }];
  for (const other of others) {
    const image = images[other.index];
    if (image && Math.abs(other.position) <= 2 && !slots.some((slot) => slot.image.id === image.id)) slots.push({ image, position: other.position });
  }

  return (
    <div className="flex w-full flex-col gap-2 md:sticky md:top-20 md:mx-auto md:w-[min(100%,calc((100svh-15rem)*2/3))]">
      <div className="group relative">
        <button
          type="button"
          data-testid="gallery-main"
          aria-label={count > 1 ? `Perbesar foto ${index + 1} dari ${count}` : "Perbesar foto"}
          onClick={handleMainClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          className="relative block aspect-[2/3] w-full cursor-zoom-in touch-pan-y overflow-hidden bg-image-bg select-none [&_img]:pointer-events-none"
        >
          <span
            ref={trackRef}
            data-testid="gallery-track"
            data-slide={motion ? (motion.direction === 1 ? "next" : motion.direction === -1 ? "prev" : "back") : undefined}
            className="absolute inset-0 block"
            style={drag && drag.offset !== 0 ? { transform: `translateX(${drag.offset}px)` } : undefined}
          >
            {slots.map(({ image, position }) => (
              <span
                key={image.id}
                data-testid={position === 0 ? "gallery-current" : undefined}
                className="absolute inset-0 block"
                style={position !== 0 ? { transform: `translateX(${position * 100}%)` } : undefined}
              >
                <ProductImage
                  src={mainSrc(image)}
                  srcSet={mainSrcSet(image)}
                  sizes={MAIN_SIZES}
                  alt={image.altText}
                  placeholderAlt={`Foto ${productName} belum tersedia`}
                  placeholderSize={1600}
                  fetchPriority={position === 0 ? "high" : undefined}
                  className="object-cover"
                />
              </span>
            ))}
          </span>
          <span aria-hidden="true" className="absolute top-3 right-3 flex size-8 items-center justify-center bg-bg text-ink">
            <ZoomIn className="size-4" strokeWidth={1.4} />
          </span>
          {count > 1 && (
            <span aria-hidden="true" data-testid="gallery-counter" className="absolute right-3 bottom-3 bg-bg px-2 py-1 text-xs text-ink">
              {index + 1} / {count}
            </span>
          )}
        </button>

        {count > 1 &&
          (
            [
              { label: "Foto sebelumnya", Icon: ChevronLeft, side: "left-0", direction: -1 },
              { label: "Foto berikutnya", Icon: ChevronRight, side: "right-0", direction: 1 },
            ] as const
          ).map(({ label, Icon, side, direction }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              onClick={() => step(direction)}
              onPointerEnter={() => warmNeighbours(index)}
              onFocus={() => warmNeighbours(index)}
              // Desktop only (phones swipe), shown on hover and on keyboard focus anywhere on the
              // main image; still focusable while hidden, and focusing one shows it.
              className={cn(
                "absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center bg-bg/90 text-ink opacity-0 transition-opacity duration-200 md:flex",
                "group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 focus-visible:opacity-100",
                side,
              )}
            >
              <Icon className="size-5" strokeWidth={1.4} aria-hidden="true" />
            </button>
          ))}
      </div>

      {count > 1 && (
        <div
          ref={stripRef}
          role="group"
          aria-label="Foto produk"
          onKeyDown={handleStripKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusIndex(null);
          }}
          className="relative -mx-1 flex gap-2 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, thumbIndex) => (
            <button
              key={image.id}
              ref={(element) => {
                thumbRefs.current[thumbIndex] = element;
              }}
              type="button"
              aria-label={`Lihat foto ${thumbIndex + 1} dari ${count}`}
              aria-current={thumbIndex === index ? "true" : undefined}
              tabIndex={thumbIndex === (focusIndex ?? index) ? 0 : -1}
              onClick={() => {
                setFocusIndex(null);
                goTo(thumbIndex);
              }}
              className={cn("relative aspect-[2/3] w-16 shrink-0 bg-image-bg md:w-20", thumbIndex === index && "outline-1 outline-offset-2 outline-ink outline-solid")}
            >
              <ProductImage src={buildImageUrl(storageBaseUrl, image.storageKey, 400)} alt="" placeholderAlt="" placeholderSize={800} sizes="80px" className="object-cover" />
            </button>
          ))}
        </div>
      )}

      <p role="status" className="sr-only">
        {liveRegionText(announcement.text, announcement.sequence)}
      </p>
    </div>
  );
}
