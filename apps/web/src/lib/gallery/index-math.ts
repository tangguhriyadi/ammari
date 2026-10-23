import type { ProductGallery } from "@/lib/content/product-view";

// Pure index arithmetic for the PDP gallery and its full-screen viewer
// (docs/plans/pdp-gallery.md §3). Navigation always wraps, in both places (owner decision 4).

/** The photo after `index`, the last one wrapping to the first. `0` for an empty gallery. */
export function nextIndex(index: number, count: number): number {
  return count > 0 ? (index + 1) % count : 0;
}

/** The photo before `index`, the first one wrapping to the last. `0` for an empty gallery. */
export function prevIndex(index: number, count: number): number {
  return count > 0 ? (index - 1 + count) % count : 0;
}

/** Where the gallery goes when the shopper picks (or re-taps) a colour: that colour's first photo.
 * A colour without photos goes to the first general photo (owner answer 3, no message), and when
 * the product has no general photo either, the gallery stays where it is. Never the reverse:
 * nothing in the gallery ever changes the colour (owner decision 3). */
export function colorJumpIndex(gallery: ProductGallery, colorId: string, currentIndex: number): number {
  const start = gallery.colorStartIndex[colorId];
  if (start !== undefined) return start;
  return gallery.images[0]?.colorId === null ? 0 : currentIndex;
}
