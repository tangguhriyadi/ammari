import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { nextIndex, prevIndex } from "./index-math";
import { GALLERY_SLIDE_EASING, GALLERY_SLIDE_MS, swipeDirection } from "./swipe";

// The slide shared by the PDP's page gallery and its full-screen viewer (docs/plans/pdp-gallery.md
// §3, §14 owner feedback): one track that follows a finger and slides to rest with one Web
// Animation, so both places move exactly alike. The caller owns the index; this hook only moves
// the track and says which photos sit where.

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** A drag in progress. Refs, not state: only the offset needs a re-render. */
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

export interface SlideSlot<T> {
  image: T;
  /** In widths from the current photo (`0`); `-1` = one width to the left. */
  position: number;
}

/** A swipe that ended past the threshold: go to the next (`1`) or previous (`-1`) photo, sliding
 * on `from` where the finger let go. */
export interface SwipeResult {
  direction: -1 | 1;
  from: string;
}

export function useSlideTrack<T extends { id: string }>(images: readonly T[], index: number) {
  const count = images.length;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<DragTrack | null>(null);
  const motionIdRef = useRef(0);

  // Runs the slide once its frames (`others` beside the current photo) are in the DOM, before the
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

  /** Where a slide still running has the track right now (px), so an interrupting slide starts
   * from there instead of jumping: the photo on screen keeps its place. */
  function trackOffsetNow(): number {
    const track = trackRef.current;
    if (!motion || !track || typeof DOMMatrixReadOnly === "undefined") return 0;
    const transform = getComputedStyle(track).transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0;
  }

  /** Slides from the current photo to `target` (the caller then sets its index to it): in from
   * `direction` (default: toward the target's side of the list), or from `from` when a swipe hands
   * over the track mid-way. Instant under reduced motion. Ends any drag. */
  function slide(target: number, { direction, from }: { direction?: -1 | 1; from?: string } = {}) {
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
  }

  /** Puts the track at rest at once: no slide, no drag (a pinch taking over, a jump without
   * animation). */
  function stop() {
    dragRef.current = null;
    setDrag(null);
    setMotion(null);
  }

  /** Starts a drag; a slide still running stops and lands under the finger. Returns whether it
   * interrupted one (a tap that stops a slide is not a tap on the photo). */
  function pointerDown(event: PointerEvent<HTMLElement>): boolean {
    const interrupted = motion !== null;
    setMotion(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0 };
    return interrupted;
  }

  /** Moves the track with the finger. Returns the drag distance, or `null` when this pointer is
   * not dragging. */
  function pointerMove(event: PointerEvent<HTMLElement>): number | null {
    const track = dragRef.current;
    if (!track || track.pointerId !== event.pointerId) return null;
    const elapsed = event.timeStamp - track.lastTime;
    if (elapsed > 0) track.velocity = (event.clientX - track.lastX) / elapsed;
    track.lastX = event.clientX;
    track.lastTime = event.timeStamp;
    const offset = event.clientX - track.startX;
    setDrag({ offset, side: offset < 0 ? 1 : offset > 0 ? -1 : 0 });
    return offset;
  }

  /** Ends the drag (pointerup or pointercancel). A short drag snaps back with the same slide; a
   * swipe past the threshold returns where to go, for the caller's own photo change. */
  function pointerEnd(event: PointerEvent<HTMLElement>): SwipeResult | null {
    const track = dragRef.current;
    if (!track || track.pointerId !== event.pointerId) return null;
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
      return null;
    }
    // Carry on from where the finger left the track: the incoming photo sits `offset` px short of
    // the edge it comes from.
    return { direction, from: `translateX(${offset + direction * width}px)` };
  }

  const current = images[index] ?? images[0];
  const others = drag
    ? drag.side === 0
      ? []
      : [{ index: drag.side === 1 ? nextIndex(index, count) : prevIndex(index, count), position: drag.side }]
    : (motion?.others ?? []);
  // Keyed by image id by the caller: the photo sliding in keeps its DOM node (and loaded file)
  // when it comes to rest, and a swipe's neighbour becomes the current photo in place, so nothing
  // flashes. A photo shows once (the first place wins); anything more than two widths away is off
  // screen anyway.
  const slots: SlideSlot<T>[] = current ? [{ image: current, position: 0 }] : [];
  for (const other of others) {
    const image = images[other.index];
    if (image && Math.abs(other.position) <= 2 && !slots.some((slot) => slot.image.id === image.id)) slots.push({ image, position: other.position });
  }

  return {
    trackRef,
    slots,
    /** Whether a slide is running (the photo is still moving in). */
    sliding: motion !== null,
    /** `data-slide` for the track: which way the running slide goes. */
    slideName: motion ? (motion.direction === 1 ? "next" : motion.direction === -1 ? "prev" : "back") : undefined,
    /** The track's inline style while a finger holds it. */
    trackStyle: drag && drag.offset !== 0 ? { transform: `translateX(${drag.offset}px)` } : undefined,
    isDragging: () => dragRef.current !== null,
    slide,
    stop,
    pointerDown,
    pointerMove,
    pointerEnd,
  };
}
