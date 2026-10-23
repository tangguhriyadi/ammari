"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@ammari/ui";
import type { ProductGalleryItem } from "@/lib/content/product-view";
import { nextIndex, prevIndex } from "@/lib/gallery/index-math";
import { GALLERY_SLIDE_EASING, GALLERY_SLIDE_MS, SWIPE_CLICK_CANCEL_PX } from "@/lib/gallery/swipe";
import { prefersReducedMotion, useSlideTrack } from "@/lib/gallery/use-slide-track";
import { canSwipe, clampPan, containedSize, isDoubleTap, NO_ZOOM, panZoom, pinchZoom, toggleZoom, type PinchStart, type Point, type Size, type Tap, type Zoom } from "@/lib/gallery/zoom";
import { buildImageUrl } from "@/lib/storage/public-url";
import { liveRegionText } from "@/lib/cart/count-event";
import { ProductImage } from "@/components/product-image";

export interface GalleryLightboxProps {
  productName: string;
  images: readonly ProductGalleryItem[];
  /** The photo it opens at: the one the page gallery showed. */
  initialIndex: number;
  /** See ProductPurchasePanelProps.storageBaseUrl. */
  storageBaseUrl: string;
  /** The main photo's box on the page right now, which the photo grows out of on open and shrinks
   * back into on close; `null` (or a box off screen or without size) = a plain fade instead. */
  getOrigin?: () => DOMRect | null;
  /** A close has started (X, Esc, back gesture...), with the photo on screen: the page gallery
   * shows it at once, so the shrinking photo lands on the same photo. */
  onClosing?: (lastIndex: number) => void;
  /** Called once, with the photo on screen, after the close animation, once the dialog is closed.
   * The page gallery shows that photo and takes focus back. */
  onClose: (lastIndex: number) => void;
}

/** `opening`/`closing`: the open/close transition runs; the viewer takes no input meanwhile (a
 * close during `opening` finishes the opening first). */
type Phase = "opening" | "open" | "closing";

/** What the fingers on the photo are doing beyond a plain swipe (that one is the slide track's):
 * two fingers pinching, one finger panning the zoomed photo, or fingers left over from a pinch at
 * 1x that must not turn into a swipe (`wait`, until all are lifted). */
type Gesture = { kind: "pinch"; start: PinchStart } | { kind: "pan"; start: Zoom; pointerId: number; x: number; y: number } | { kind: "wait" };

/** A touch that may be a tap (for double-tap): where and when it went down, and whether it moved
 * or had company since. */
interface TapCandidate {
  start: Tap;
  moved: boolean;
  multi: boolean;
}

const ARROW_CLASS = "absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center bg-bg/90 text-ink";

/** Fetches the 1600 file of the photos either side of `around` (only those: the viewer never
 * loads the whole gallery), so the next swipe or arrow press shows a loaded photo. */
function warmNeighbours(images: readonly ProductGalleryItem[], around: number, storageBaseUrl: string, warmed: Set<string>) {
  const count = images.length;
  if (count < 2) return;
  for (const neighbour of [nextIndex(around, count), prevIndex(around, count)]) {
    const image = images[neighbour];
    if (!image || warmed.has(image.id)) continue;
    warmed.add(image.id);
    new Image().src = buildImageUrl(storageBaseUrl, image.storageKey, 1600);
  }
}

/** The PDP's full-screen photo viewer (docs/plans/pdp-gallery.md §3.3, §7): a native modal
 * `<dialog>` (focus stays inside, the page behind is inert, Esc closes) on white, with the whole
 * photo in its large file, a counter, prev/next (wrapping) and a close button. Every photo change
 * slides exactly like the page gallery (same track, use-slide-track.ts). Desktop: Left/Right and
 * Esc, no zoom (owner answer 6). Touch: swipe at 1x, pinch-zoom 1x to 4x with pan while zoomed,
 * double-tap toggles 1x/2.5x; a new photo starts at 1x. Viewing photos here never touches the
 * colour: it only ever hands its last index back. */
export function GalleryLightbox({ productName, images, initialIndex, storageBaseUrl, getOrigin, onClosing, onClose }: GalleryLightboxProps) {
  const count = images.length;
  const [index, setIndex] = useState(() => (Number.isInteger(initialIndex) ? Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0)) : 0));
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  // Whether the zoom eases to its new value (double-tap) or follows the fingers (pinch, pan).
  const [zoomEases, setZoomEases] = useState(false);
  // Polite announcement of every photo change; the sequence makes a repeat announce again.
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  // Mirrored in `phaseRef` for handlers; the state only feeds `data-state` (tests, styling hooks).
  const [phase, setPhase] = useState<Phase>("opening");
  const track = useSlideTrack(images, index);
  const { trackRef, slots, slideName, trackStyle } = track;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Mirrors `zoom` for pointer handlers that run before the next render.
  const zoomRef = useRef<Zoom>(NO_ZOOM);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const tapRef = useRef<TapCandidate | null>(null);
  const lastTapRef = useRef<Tap | null>(null);
  const warmedRef = useRef(new Set<string>());
  const closedRef = useRef(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("opening");
  // The open or close transition's animations, so a close can finish an opening first and an
  // unmount (StrictMode's effect re-run included) can cancel them.
  const transitionRef = useRef<Animation[]>([]);
  // The safety timer of the running transition (an animation that never reports its end must not
  // leave the viewer stuck opening or half-closed); cleared on unmount.
  const transitionTimerRef = useRef<number | undefined>(undefined);

  // Open as a modal on mount, growing the photo out of the main photo (before the first paint, so
  // the full-screen state never flashes); lock the page behind it. `overflow: hidden` on <html>,
  // not only <body> (iOS Safari ignores it there); a classic scrollbar keeps its gutter while
  // hidden, so nothing behind the viewer moves on open or close.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const root = document.documentElement;
    const previous = { overflow: root.style.overflow, scrollbarGutter: root.style.scrollbarGutter };
    const hasScrollbar = window.innerWidth > root.clientWidth;
    root.style.overflow = "hidden";
    if (hasScrollbar) root.style.scrollbarGutter = "stable";
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const opening = runTransition("in");
    transitionRef.current = opening;
    if (opening[0]) {
      setPhaseBoth("opening");
      const opened = () => {
        window.clearTimeout(transitionTimerRef.current);
        if (phaseRef.current === "opening") setPhaseBoth("open");
      };
      opening[0].onfinish = opened;
      transitionTimerRef.current = window.setTimeout(opened, GALLERY_SLIDE_MS + 200);
    } else {
      setPhaseBoth("open");
    }
    // iOS Safari's own pinch (its non-standard gesture events) would zoom the page instead of the
    // photo; touch-action on the stage alone does not stop it everywhere.
    const preventPageZoom = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", preventPageZoom);
    return () => {
      window.clearTimeout(transitionTimerRef.current);
      for (const animation of transitionRef.current) animation.cancel();
      transitionRef.current = [];
      document.removeEventListener("gesturestart", preventPageZoom);
      if (dialog.open) dialog.close();
      root.style.overflow = previous.overflow;
      root.style.scrollbarGutter = previous.scrollbarGutter;
    };
    // Mount only: `runTransition` reads the latest refs and props when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    warmNeighbours(images, index, storageBaseUrl, warmedRef.current);
  }, [images, index, storageBaseUrl]);

  // Rotating the phone (or resizing the window) while zoomed: keep the photo covering the new
  // stage instead of showing the background past its edge.
  const handleResize = useEffectEvent(() => {
    const frame = geometry();
    if (frame && zoomRef.current.scale > 1) applyZoom(clampPan(zoomRef.current, frame.stage, frame.photo));
  });

  useEffect(() => {
    const listener = () => handleResize();
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }, []);

  function setPhaseBoth(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  /** The transform that puts the photo exactly over the main photo on the page (the stage scales
   * around its centre, where the photo sits), or `null` when that box is unknown, has no size or
   * is off screen: a plain fade then. */
  function originTransform(): string | null {
    const origin = getOrigin?.();
    const frame = geometry();
    if (!origin || !frame || !(origin.width > 0 && origin.height > 0 && frame.photo.width > 0)) return null;
    if (origin.bottom <= 0 || origin.right <= 0 || origin.top >= window.innerHeight || origin.left >= window.innerWidth) return null;
    const dx = origin.left + origin.width / 2 - (frame.rect.left + frame.rect.width / 2);
    const dy = origin.top + origin.height / 2 - (frame.rect.top + frame.rect.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${origin.width / frame.photo.width})`;
  }

  /** Starts the open (`in`) or close (`out`) transition: the photo between the main photo's box
   * and full screen while the white backdrop and the controls fade, or the whole viewer fading
   * when the box is unknown. Same duration and ease-out as every slide. None under reduced
   * motion (instant). Returns its animations (empty = nothing to wait for). */
  function runTransition(direction: "in" | "out"): Animation[] {
    const dialog = dialogRef.current;
    const stage = stageRef.current;
    const backdrop = backdropRef.current;
    if (!dialog || !stage || !backdrop || typeof dialog.animate !== "function" || prefersReducedMotion()) return [];
    // Before the open starts nothing shows yet; after the close ends the closed state holds until
    // the dialog closes.
    const timing: KeyframeAnimationOptions = { duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING, fill: direction === "in" ? "backwards" : "forwards" };
    const fade = direction === "in" ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    const flip = originTransform();
    if (!flip) return [dialog.animate(fade, timing)];
    const photo = direction === "in" ? [{ transform: flip }, { transform: "none" }] : [{ transform: "none" }, { transform: flip }];
    const controls = [...dialog.querySelectorAll<HTMLElement>("[data-viewer-control]")];
    return [stage.animate(photo, timing), backdrop.animate(fade, timing), ...controls.map((control) => control.animate(fade, timing))];
  }

  /** Closes with the photo on screen: the page gallery shows it at once, the photo shrinks back
   * into the main photo, then the dialog closes and the opener takes over. Once only (X then Esc
   * in the same frame, say). During the opening, the opening simply plays backwards from where it
   * is (same photo, same box), so nothing jumps. A dialog the browser already closed (a close we
   * could not cancel) skips the animation. */
  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    const wasOpening = phaseRef.current === "opening";
    window.clearTimeout(transitionTimerRef.current);
    track.stop();
    gestureRef.current = null;
    setPhaseBoth("closing");
    onClosing?.(index);
    let closing: Animation[] = [];
    if (dialogRef.current?.open && wasOpening && transitionRef.current.length > 0) {
      closing = transitionRef.current;
      for (const animation of closing) animation.reverse();
    } else {
      for (const animation of transitionRef.current) animation.cancel();
      if (dialogRef.current?.open) closing = runTransition("out");
    }
    transitionRef.current = closing;
    if (!closing[0]) {
      finishClose();
      return;
    }
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      window.clearTimeout(transitionTimerRef.current);
      finishClose();
    };
    closing[0].onfinish = end;
    // Never left half-closed (page locked) if the animation never reports its end.
    transitionTimerRef.current = window.setTimeout(end, GALLERY_SLIDE_MS + 200);
  }

  function finishClose() {
    const dialog = dialogRef.current;
    // Closed before the page gallery moves focus: the page must not be inert by then.
    if (dialog?.open) dialog.close();
    onClose(index);
  }

  function applyZoom(next: Zoom, ease = false) {
    zoomRef.current = next;
    setZoom(next);
    setZoomEases(ease);
  }

  function goTo(target: number, options: { direction: -1 | 1; from?: string }) {
    if (target === index) return;
    // Zoomed in (arrows or keys; a swipe needs 1x): only the incoming photo carries the zoom, so
    // the zoomed photo would snap to 1x as it slides out. Swap at once instead.
    if (zoomRef.current.scale > 1) track.stop();
    else track.slide(target, options);
    setIndex(target);
    gestureRef.current = null;
    lastTapRef.current = null;
    applyZoom(NO_ZOOM);
    setAnnouncement((previous) => ({ text: `Foto ${target + 1} dari ${count}`, sequence: previous.sequence + 1 }));
  }

  function step(direction: -1 | 1) {
    if (phaseRef.current !== "open") return;
    goTo(direction === 1 ? nextIndex(index, count) : prevIndex(index, count), { direction });
  }

  function showPrevious() {
    step(-1);
  }

  function showNext() {
    step(1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    // Taken either way, so the page's own Left/Right never sees it.
    event.preventDefault();
    // A finger still holding the photo owns it until release; nothing moves mid-transition.
    if (phaseRef.current !== "open" || count < 2 || track.isDragging() || gestureRef.current) return;
    step(event.key === "ArrowRight" ? 1 : -1);
  }

  /** The stage's size and the photo's drawn size in it, for the zoom math. */
  function geometry(): { rect: DOMRect; stage: Size; photo: Size } | null {
    const element = stageRef.current;
    const image = images[index];
    if (!element || !image) return null;
    const rect = element.getBoundingClientRect();
    const stage = { width: rect.width, height: rect.height };
    return { rect, stage, photo: containedSize(stage, image.width, image.height) };
  }

  /** A client point in stage-centre coordinates (zoom.ts's frame). */
  function stagePoint(rect: DOMRect, x: number, y: number): Point {
    return { x: x - (rect.left + rect.width / 2), y: y - (rect.top + rect.height / 2) };
  }

  /** The first two fingers' midpoint (client coordinates) and distance apart. */
  function fingers(): { centre: Point; distance: number } | null {
    const [a, b] = [...pointersRef.current.values()];
    if (!a || !b) return null;
    return { centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.pointerType === "mouse" && event.button !== 0) || phaseRef.current !== "open") return;
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Every pointer that goes down here also comes up here (even released outside the stage), so
    // none lingers in the map to turn the next single touch into a pinch.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // Zoom is touch only: no wheel, click or trackpad zoom on desktop (owner answer 6).
    const touch = event.pointerType === "touch";
    if (touch) {
      if (pointers.size === 1) tapRef.current = { start: { time: event.timeStamp, x: event.clientX, y: event.clientY }, moved: false, multi: false };
      else if (tapRef.current) tapRef.current.multi = true;
    }

    if (touch && pointers.size === 2) {
      // A second finger: pinch. A swipe already under way gives the photo back at once.
      track.stop();
      const pair = fingers();
      const frame = geometry();
      gestureRef.current = pair && frame ? { kind: "pinch", start: { zoom: zoomRef.current, centre: stagePoint(frame.rect, pair.centre.x, pair.centre.y), distance: pair.distance } } : { kind: "wait" };
      return;
    }
    if (pointers.size !== 1 || gestureRef.current) return;
    if (!canSwipe(zoomRef.current)) {
      // Zoomed in: one finger pans the photo; changing photo waits until it is back at 1x.
      gestureRef.current = { kind: "pan", start: zoomRef.current, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    if (count > 1) track.pointerDown(event);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId) || phaseRef.current !== "open") return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const tap = tapRef.current;
    if (tap && Math.hypot(event.clientX - tap.start.x, event.clientY - tap.start.y) > SWIPE_CLICK_CANCEL_PX) tap.moved = true;

    const gesture = gestureRef.current;
    if (!gesture) {
      track.pointerMove(event);
      return;
    }
    const frame = geometry();
    if (!frame) return;
    if (gesture.kind === "pinch") {
      const pair = fingers();
      if (pair) applyZoom(pinchZoom(gesture.start, stagePoint(frame.rect, pair.centre.x, pair.centre.y), pair.distance, frame.stage, frame.photo));
    } else if (gesture.kind === "pan" && gesture.pointerId === event.pointerId) {
      applyZoom(panZoom(gesture.start, { x: event.clientX - gesture.x, y: event.clientY - gesture.y }, frame.stage, frame.photo));
    }
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const pointers = pointersRef.current;
    if (!pointers.delete(event.pointerId)) return;
    // Closing: fingers still down only need letting go of, nothing else.
    if (phaseRef.current !== "open") {
      tapRef.current = null;
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) {
      const swipe = track.pointerEnd(event);
      if (swipe) goTo(swipe.direction === 1 ? nextIndex(index, count) : prevIndex(index, count), swipe);
    } else if (pointers.size === 0) {
      gestureRef.current = null;
    } else if (gesture.kind === "pinch") {
      // One finger left after a pinch: zoomed, it pans on from where it is; at 1x it does
      // nothing until lifted (it must not turn into a swipe).
      const [rest] = pointers.entries();
      gestureRef.current = rest && !canSwipe(zoomRef.current) ? { kind: "pan", start: zoomRef.current, pointerId: rest[0], x: rest[1].x, y: rest[1].y } : { kind: "wait" };
    }
    if (pointers.size === 0) handleTapEnd(event);
  }

  /** The last finger lifted: a still, single-finger touch is a tap, and a second tap soon after,
   * near the first, toggles the zoom around it. */
  function handleTapEnd(event: PointerEvent<HTMLDivElement>) {
    const tap = tapRef.current;
    tapRef.current = null;
    if (event.type !== "pointerup" || event.pointerType !== "touch" || !tap || tap.moved || tap.multi) {
      lastTapRef.current = null;
      return;
    }
    const now = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    if (!isDoubleTap(lastTapRef.current, now)) {
      lastTapRef.current = now;
      return;
    }
    lastTapRef.current = null;
    const frame = geometry();
    if (!frame) return;
    track.stop();
    applyZoom(toggleZoom(zoomRef.current, stagePoint(frame.rect, event.clientX, event.clientY), frame.stage, frame.photo), !prefersReducedMotion());
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Galeri foto ${productName}`}
      data-testid="gallery-viewer"
      // Esc: closed through `close()`, so the page gallery always learns the last photo.
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      // A close this component did not start (a repeated Esc the browser no longer lets it
      // cancel, the Android back gesture): still hand the photo back and unlock the page. Only
      // when really closed: StrictMode's effect re-run closes and reopens it in development.
      onClose={() => {
        if (!dialogRef.current?.open) close();
      }}
      onKeyDown={handleKeyDown}
      data-state={phase}
      // Transparent itself: the white comes from the backdrop layer below, which fades on its own
      // while the photo grows out of (or back into) the page.
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-hidden overscroll-contain bg-transparent p-0 text-ink backdrop:bg-transparent"
    >
      <div ref={backdropRef} aria-hidden="true" data-testid="viewer-backdrop" className="absolute inset-0 bg-bg" />
      <div className="relative flex h-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        <div data-viewer-control className="flex h-14 shrink-0 items-center justify-between pr-1 pl-4">
          <span aria-hidden="true" data-testid="viewer-counter" className="text-sm">
            {count > 1 ? `${index + 1} / ${count}` : null}
          </span>
          <button ref={closeRef} type="button" aria-label="Tutup" onClick={close} className="flex size-11 items-center justify-center">
            <X className="size-5" strokeWidth={1.4} aria-hidden="true" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={stageRef}
            data-testid="viewer-stage"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            // touch-none: every finger on the photo is ours (swipe, pinch, pan, double-tap), never
            // the browser's page zoom or scroll.
            className="absolute inset-0 touch-none overflow-hidden select-none [&_img]:pointer-events-none"
          >
            <span ref={trackRef} data-testid="viewer-track" data-slide={slideName} className="absolute inset-0 block" style={trackStyle}>
              {slots.map(({ image, position }) => (
                <span
                  key={image.id}
                  data-testid={position === 0 ? "viewer-current" : undefined}
                  className="absolute inset-0 block"
                  style={position !== 0 ? { transform: `translateX(${position * 100}%)` } : undefined}
                >
                  <span
                    data-testid={position === 0 ? "viewer-zoom" : undefined}
                    data-scale={position === 0 ? zoom.scale : undefined}
                    className="absolute inset-0 block"
                    style={
                      position === 0
                        ? {
                            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                            transition: zoomEases ? `transform ${GALLERY_SLIDE_MS}ms ${GALLERY_SLIDE_EASING}` : undefined,
                          }
                        : undefined
                    }
                  >
                    <ProductImage
                      src={buildImageUrl(storageBaseUrl, image.storageKey, 1600)}
                      alt={image.altText}
                      placeholderAlt={`Foto ${productName} belum tersedia`}
                      placeholderSize={1600}
                      sizes="100vw"
                      loading="eager"
                      className="object-contain"
                    />
                  </span>
                </span>
              ))}
            </span>
          </div>

          {count > 1 && (
            <>
              <button type="button" data-viewer-control aria-label="Foto sebelumnya" onClick={showPrevious} className={cn(ARROW_CLASS, "left-1")}>
                <ChevronLeft className="size-5" strokeWidth={1.4} aria-hidden="true" />
              </button>
              <button type="button" data-viewer-control aria-label="Foto berikutnya" onClick={showNext} className={cn(ARROW_CLASS, "right-1")}>
                <ChevronRight className="size-5" strokeWidth={1.4} aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        <p role="status" className="sr-only">
          {liveRegionText(announcement.text, announcement.sequence)}
        </p>
      </div>
    </dialog>
  );
}
