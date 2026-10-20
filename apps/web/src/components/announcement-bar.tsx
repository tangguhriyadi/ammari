/** docs/design/storefront.md §4 "Announcement bar". A full-width strip ABOVE the sticky header,
 * in normal document flow (deliberately NOT sticky): it scrolls away with the page while the
 * header, `sticky top-0`, takes over the top edge exactly when the bar is gone, so the header
 * never jumps and no sticky offset anywhere has to know whether the bar exists. Height is fixed
 * (36px mobile, 40px from `lg`, the header's own desktop breakpoint) and the text is kept to one
 * line: the admin form caps it at a length that fits a 360px phone, and `truncate` is the
 * last-resort guard so a too-long value can never grow the bar to two lines. Type mirrors the
 * desktop nav links: small uppercase Jost with wide tracking. The caller renders nothing at all
 * when the bar is off or empty, so it leaves no gap. */
export function AnnouncementBar({ text }: { text: string }) {
  return (
    <div
      role="region"
      aria-label="Pengumuman"
      data-testid="announcement-bar"
      className="flex h-9 items-center justify-center bg-brand px-4 text-white lg:h-10 lg:px-10"
    >
      <p className="truncate text-[11px] font-medium tracking-[0.12em] uppercase lg:text-xs lg:tracking-[0.16em]">{text}</p>
    </div>
  );
}
