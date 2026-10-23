"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@ammari/ui";
import { PRODUCT_PLACEHOLDER_ALT, PRODUCT_PLACEHOLDER_SRC, type ProductPlaceholderSize } from "@/lib/content/product-placeholder";

export interface ProductImageProps {
  /** Absolute URL of the real photo, or `null` when there is none: the placeholder renders
   * immediately in that case, same as after a load error. */
  src: string | null;
  alt: string;
  /** Alt text while the placeholder shows. Defaults to a description; a tile passes "" because its
   * link already names the product, so screen readers don't repeat the phrase on every tile. */
  placeholderAlt?: string;
  /** Which placeholder width to use when falling back — match the real photo's own size. */
  placeholderSize: ProductPlaceholderSize;
  sizes: string;
  priority?: boolean;
  /** Responsive mode (lib/storage/public-url.ts's `buildImageSrcSet`): the real photo renders as a
   * plain `<img>` with this `srcset`, so the browser picks the file per viewport and pixel
   * density. next/image can't do that here: `images.unoptimized` (next.config.ts) makes it emit
   * no srcset and drop a passed one (docs/plans/pdp-gallery.md §5). The placeholder still goes
   * through next/image. */
  srcSet?: string;
  /** Responsive mode only: `"high"` for the one LCP photo (also loads it eagerly); every other
   * photo stays lazy. */
  fetchPriority?: "high" | "auto";
  className?: string;
}

/** Every storefront product photo (tiles, PDP gallery) renders through this, so none of them can
 * ever show the browser's broken-image icon: a missing photo or one that fails to load (a deleted
 * storage object, storage briefly down) swaps to the static placeholder. Always `fill` inside the
 * caller's own aspect-[2/3] box, so the swap never shifts layout. The failure is remembered per
 * `src` (not as a plain boolean), so a new `src` (e.g. the shopper picks another colour) gets a
 * fresh attempt, and the placeholder's own src never changes again once shown: no retry loop. */
export function ProductImage({ src, alt, placeholderAlt = PRODUCT_PLACEHOLDER_ALT, placeholderSize, sizes, priority = false, srcSet, fetchPriority, className }: ProductImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPlaceholder = src === null || failedSrc === src;

  if (srcSet && !showPlaceholder) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- next/image can't serve a srcset with images.unoptimized (see the srcSet prop's doc comment)
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        loading={fetchPriority === "high" ? "eager" : "lazy"}
        fetchPriority={fetchPriority}
        decoding="async"
        onError={() => setFailedSrc(src)}
        // Same box next/image's `fill` gives: the caller's aspect-ratio container sets the size.
        className={cn("absolute inset-0 size-full", className)}
      />
    );
  }

  return (
    <Image
      src={showPlaceholder ? PRODUCT_PLACEHOLDER_SRC[placeholderSize] : src}
      alt={showPlaceholder ? placeholderAlt : alt}
      fill
      priority={priority}
      sizes={sizes}
      onError={showPlaceholder ? undefined : () => setFailedSrc(src)}
      className={className}
      data-placeholder={showPlaceholder ? "true" : undefined}
    />
  );
}
