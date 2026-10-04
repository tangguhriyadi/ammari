"use client";

import { useState } from "react";

// Generated via packages/ui/assets/generate-fallback-images.mjs from the owner's placeholder
// (packages/ui/assets/fallback-image.png) — re-run that script if the placeholder changes.
const FALLBACK_SRC = "/images/fallback-product-400.webp";
const FALLBACK_SRCSET =
  "/images/fallback-product-400.webp 400w, /images/fallback-product-800.webp 800w, /images/fallback-product-1600.webp 1600w";
const FALLBACK_ALT = "Foto belum tersedia";

export interface ProductImageProps {
  /** `null` renders the fallback immediately — same as a load error, just without needing one
   * to happen first (e.g. a product with no thumbnail yet). */
  src: string | null;
  srcSet?: string;
  sizes?: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}

/** The one place a product image's `<img>` is rendered — list thumbnail, detail header, and
 * every photo tile. Falls back to the shared placeholder WebP set whenever the real image fails
 * to load (a storage object that's been deleted, a bad URL) instead of ever showing the
 * browser's broken-image icon, and swaps in a generic, still-meaningful alt text to match.
 * Loop-guarded: `errored` only ever flips false -> true, so once the fallback is showing, its
 * own `src` never changes again — a broken fallback asset can't retry indefinitely. */
export function ProductImage({ src, srcSet, sizes, alt, className, loading = "lazy" }: ProductImageProps) {
  const [errored, setErrored] = useState(false);
  const showFallback = errored || !src;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={showFallback ? FALLBACK_SRC : src}
      srcSet={showFallback ? FALLBACK_SRCSET : srcSet}
      sizes={showFallback ? "(max-width: 640px) 25vw, 120px" : sizes}
      loading={loading}
      alt={showFallback ? FALLBACK_ALT : alt}
      onError={showFallback ? undefined : () => setErrored(true)}
      className={className}
    />
  );
}
