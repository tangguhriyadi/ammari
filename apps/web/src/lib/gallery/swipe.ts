// Pure swipe decision for the PDP gallery's main image (docs/plans/pdp-gallery.md §3.2): the
// component only feeds it the drag distance, the image width and the release speed.

/** Release past this share of the image width goes to the next/previous photo. */
export const SWIPE_DISTANCE_RATIO = 0.2;
/** A faster release than this (px per ms) counts as a flick, even over a short distance. */
export const SWIPE_FLICK_PX_PER_MS = 0.4;
/** A drag longer than this (px) is a swipe, never a click (it must not open the viewer). */
export const SWIPE_CLICK_CANCEL_PX = 10;
/** Every slide of the main photo (arrows, thumbnails, keys, colour jumps, a swipe's finish or
 * snap-back): one duration and one ease-out, so they all feel the same (owner feedback
 * 2026-10-23). The ease-out curve matches the Curtain's opening (globals.css). */
export const GALLERY_SLIDE_MS = 300;
export const GALLERY_SLIDE_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";

/** `1` = next photo (dragged left), `-1` = previous photo (dragged right), `0` = snap back.
 * `dx` is the drag distance (negative = left), `velocity` the release speed in px/ms (same sign
 * convention). A flick only counts in the direction of the drag and past the click threshold. */
export function swipeDirection(dx: number, width: number, velocity: number): -1 | 0 | 1 {
  if (width <= 0 || Math.abs(dx) <= SWIPE_CLICK_CANCEL_PX) return 0;
  const farEnough = Math.abs(dx) > width * SWIPE_DISTANCE_RATIO;
  const flicked = Math.abs(velocity) > SWIPE_FLICK_PX_PER_MS && Math.sign(velocity) === Math.sign(dx);
  if (!farEnough && !flicked) return 0;
  return dx < 0 ? 1 : -1;
}
