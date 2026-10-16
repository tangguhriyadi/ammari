import type { WhyAmmariView } from "@/lib/content/homepage-view";
import { WHY_AMMARI_ICONS } from "@/lib/content/icons";
import { Container } from "@/components/container";
import { Eyebrow } from "@/components/eyebrow";

/** docs/design/storefront.md §5 item 3 — surface-coloured band, eyebrow + H2, up to 4 points in
 * a 2-col (4 on desktop) grid: icon, title, short text. */
export function WhyAmmariSection({ section }: { section: WhyAmmariView }) {
  return (
    <section className="bg-surface py-10 md:py-14">
      <Container>
        <div className="mb-6 flex flex-col gap-2">
          {section.eyebrow && <Eyebrow>{section.eyebrow}</Eyebrow>}
          <h2 className="font-serif text-2xl font-normal text-ink">{section.heading}</h2>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4">
          {section.points.map((point, index) => {
            const Icon = WHY_AMMARI_ICONS[point.icon];
            return (
              <div key={index} className="flex flex-col gap-2">
                <Icon className="size-5 text-ink" strokeWidth={1.4} aria-hidden="true" />
                <p className="text-sm font-medium text-ink">{point.title}</p>
                <p className="text-xs text-ink-muted">{point.text}</p>
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
