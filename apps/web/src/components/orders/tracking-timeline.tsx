// The buyer's courier history in "Lacak pengiriman" (/orders/[orderNo]). A vertical timeline, newest
// on top: older entries are small filled brand dots on a solid line, the latest is a larger dot with
// a medium-weight title, and a milestone not reached yet ("Terkirim" while the parcel is still on
// its way) is grey. Display only: labels and notes arrive already in buyer-safe Indonesian
// (lib/orders/tracking.ts), no status codes, sources or provider ids are ever passed in here.

export interface TrackingTimelineEvent {
  label: string;
  note: string | null;
  /** ISO time. */
  dateTime: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const JAKARTA_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "21 Nov 2026, 05.10" in Asia/Jakarta. */
function formatEventTime(iso: string): string {
  const parts = Object.fromEntries(JAKARTA_PARTS.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}.${parts.minute}`;
}

export function TrackingTimeline({ events, awaitingDelivery }: { events: readonly TrackingTimelineEvent[]; awaitingDelivery: boolean }) {
  return (
    <ol role="list" className="mt-2 flex flex-col" aria-label="Riwayat pengiriman" data-testid="tracking-timeline">
      {awaitingDelivery && (
        <li className="flex gap-4" data-testid="tracking-waiting">
          <div className="relative w-5 shrink-0 self-stretch" aria-hidden="true">
            <span className="absolute top-[13px] -bottom-[13px] left-1/2 w-0.5 -translate-x-1/2 bg-line-strong" />
            <span className="absolute top-[13px] left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-line-strong" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col pb-5">
            <p className="text-[15px] leading-6 text-disabled">
              Terkirim<span className="sr-only"> (belum tercapai)</span>
            </p>
          </div>
        </li>
      )}
      {events.map((entry, index) => {
        const last = index === events.length - 1;
        const current = index === 0;
        return (
          <li key={`${entry.dateTime}-${index}`} className="flex gap-4" aria-current={current ? "step" : undefined}>
            <div className="relative w-5 shrink-0 self-stretch" aria-hidden="true">
              {!last && <span className="absolute top-[13px] -bottom-[13px] left-1/2 w-0.5 -translate-x-1/2 bg-brand" />}
              <span
                className={`absolute top-[13px] left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand ${
                  current ? "size-3.5 ring-4 ring-brand/20" : "size-2.5"
                }`}
              />
            </div>
            <div className={`flex min-w-0 flex-1 flex-col gap-0.5 ${last ? "" : "pb-5"}`}>
              <p className={`text-[15px] leading-6 text-ink ${current ? "font-medium" : ""}`}>
                {entry.label}
                {current && <span className="sr-only"> (terbaru)</span>}
              </p>
              <time dateTime={entry.dateTime} className="text-[15px] text-ink-muted">
                {formatEventTime(entry.dateTime)}
              </time>
              {entry.note && <p className="text-[15px] break-words text-ink-muted">{entry.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
