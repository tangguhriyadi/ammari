import type { ResolvedHero } from "@/lib/content/homepage-resolve";
import { buildImageSrcSet, getStoragePublicBaseUrl, IMAGE_SIZES, storageImageUrl } from "@/lib/storage/public-url";
import { Eyebrow } from "@/components/eyebrow";
import { HeroCtaLink } from "@/components/buttons";

/** Tailwind's `md`, where the desktop crop takes over. */
const DESKTOP_MEDIA = "(min-width: 768px)";

/** docs/design/storefront.md §5 item 1 — full-bleed image (620px mobile, 85vh desktop), optional
 * separate mobile crop, eyebrow+H1 overlay top-left, full-width outlined-to-filled CTA bottom.
 *
 * The photo is the homepage's LCP element. One `<picture>` (art direction) rather than two
 * next/image `priority` images toggled by CSS: those preloaded BOTH crops on every device, a
 * hidden 1600px file included. Here the browser fetches only the crop for its viewport, and picks
 * the size from the pre-generated 400/800/1600 set (next/image can't emit a srcset with
 * `images.unoptimized`, see next.config.ts). The box size is fixed by the section, so the photo
 * arriving never shifts layout. */
export function HeroSection({ hero }: { hero: ResolvedHero }) {
  const base = hero.image ? getStoragePublicBaseUrl() : null;
  return (
    <section className="relative h-[620px] w-full overflow-hidden bg-surface md:h-[85vh]">
      {hero.image && base && (
        <picture>
          {hero.image.mobileStorageKey && <source media={DESKTOP_MEDIA} srcSet={buildImageSrcSet(base, hero.image.storageKey, IMAGE_SIZES)} sizes="100vw" />}
          <img
            src={storageImageUrl(hero.image.mobileStorageKey ?? hero.image.storageKey, 1600)}
            srcSet={buildImageSrcSet(base, hero.image.mobileStorageKey ?? hero.image.storageKey, IMAGE_SIZES)}
            sizes="100vw"
            alt={hero.image.altText}
            fetchPriority="high"
            loading="eager"
            className="absolute inset-0 size-full object-cover"
          />
        </picture>
      )}
      <div className="absolute inset-0 flex flex-col justify-between p-4 md:p-6">
        <div className="flex max-w-md flex-col gap-2">
          {hero.eyebrow && <Eyebrow>{hero.eyebrow}</Eyebrow>}
          <h1 className="font-serif text-[40px] leading-[1.05] font-light whitespace-pre-line text-ink">{hero.headline}</h1>
        </div>
        {hero.ctaLabel && (
          <HeroCtaLink href={hero.ctaHref} className="w-full">
            {hero.ctaLabel}
          </HeroCtaLink>
        )}
      </div>
    </section>
  );
}
