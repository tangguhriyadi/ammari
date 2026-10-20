import Image from "next/image";
import Link from "next/link";
import type { ResolvedFeatureBlock } from "@/lib/content/homepage-resolve";
import { storageImageUrl } from "@/lib/storage/public-url";
import { cn } from "@ammari/ui";
import { Container } from "@/components/container";

/** docs/design/storefront.md §5 item 4 — large image, white caption bar: title (Cormorant 22px) +
 * subtitle, underlined "LIHAT" text-link to the linked product. */
export function FeatureBlockSection({ block }: { block: ResolvedFeatureBlock }) {
  return (
    <section>
      <div className="group/media relative h-[600px] w-full bg-image-bg">
        {block.image && (
          <Image
            src={storageImageUrl(block.image.storageKey, 1600)}
            alt={block.image.altText}
            fill
            className={cn("object-cover", block.href && "transition-opacity duration-200 motion-reduce:transition-none group-hover/media:opacity-90")}
          />
        )}
        {/* Same `block.href` as the text button below, so the two can't diverge. The button stays the
         * one accessible link: this overlay is out of the tab order and hidden from screen readers. */}
        {block.href && <Link href={block.href} tabIndex={-1} aria-hidden="true" data-testid="feature-block-image-link" className="absolute inset-0 z-10 cursor-pointer" />}
      </div>
      <Container className="flex items-center justify-between gap-4 bg-bg py-5">
        <div className="flex flex-col gap-1">
          <h3 className="font-serif text-[22px] font-normal text-ink">{block.title}</h3>
          <p className="text-sm text-ink-muted">{block.subtitle}</p>
        </div>
        {block.href && (
          <Link href={block.href} className="shrink-0 text-xs font-medium tracking-[0.16em] text-ink uppercase underline underline-offset-4">
            {block.ctaLabel}
          </Link>
        )}
      </Container>
    </section>
  );
}
