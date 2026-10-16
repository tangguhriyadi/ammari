import Image from "next/image";
import { cn } from "@ammari/ui";
import type { ResolvedHero } from "@/lib/content/homepage-resolve";
import { storageImageUrl } from "@/lib/storage/public-url";
import { Eyebrow } from "@/components/eyebrow";
import { PrimaryLink } from "@/components/buttons";

/** docs/design/storefront.md §5 item 1 — full-bleed image (620px mobile, 85vh desktop), optional
 * separate mobile crop, eyebrow+H1 overlay top-left, full-width primary button bottom. */
export function HeroSection({ hero }: { hero: ResolvedHero }) {
  return (
    <section className="relative h-[620px] w-full overflow-hidden bg-surface md:h-[85vh]">
      {hero.image && (
        <>
          {hero.image.mobileStorageKey && (
            <Image
              src={storageImageUrl(hero.image.mobileStorageKey, 1600)}
              alt={hero.image.altText}
              fill
              priority
              className="object-cover md:hidden"
            />
          )}
          <Image
            src={storageImageUrl(hero.image.storageKey, 1600)}
            alt={hero.image.altText}
            fill
            priority
            className={cn("object-cover", hero.image.mobileStorageKey && "hidden md:block")}
          />
        </>
      )}
      <div className="absolute inset-0 flex flex-col justify-between p-4 md:p-6">
        <div className="flex max-w-md flex-col gap-2">
          {hero.eyebrow && <Eyebrow>{hero.eyebrow}</Eyebrow>}
          <h1 className="font-serif text-[40px] leading-[1.05] font-light whitespace-pre-line text-ink">{hero.headline}</h1>
        </div>
        {hero.ctaLabel && (
          <PrimaryLink href={hero.ctaHref} className="w-full">
            {hero.ctaLabel}
          </PrimaryLink>
        )}
      </div>
    </section>
  );
}
