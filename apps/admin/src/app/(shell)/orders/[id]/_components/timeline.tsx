import { formatDateTime } from "@ammari/ui/lib";

// A vertical timeline (dot, connecting line, title, time, description). Three states:
//  - done: small filled brand dot, solid brand line to the next item, title in ink.
//  - current: the latest item, a larger dot with a soft ring, title in medium weight, description in ink.
//  - waiting: a milestone not reached yet, grey dot, grey line, grey title.
// Items are listed newest first; the line under an item leads to the (older) item below it and is
// brand coloured unless the item itself is still waiting.

export type TimelineState = "done" | "current" | "waiting";

export interface TimelineItem {
  key: string;
  title: string;
  state: TimelineState;
  time?: Date;
  /** Tiny muted text after the time (source, raw provider code). */
  meta?: string;
  description?: string;
  /** A title that repeats the status of the entry before it: lighter. */
  repeatedTitle?: boolean;
}

export function Timeline({ items, compact = false, testId, label }: { items: TimelineItem[]; compact?: boolean; testId?: string; label?: string }) {
  return (
    <ol className="flex flex-col" data-testid={testId} aria-label={label}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const waiting = item.state === "waiting";
        const current = item.state === "current";
        const titleClass = waiting || (item.repeatedTitle && !current) ? "text-neutral-600" : "text-neutral-900";
        return (
          <li key={item.key} className="flex gap-3" aria-current={current ? "step" : undefined}>
            <div className="relative w-5 shrink-0 self-stretch" aria-hidden="true">
              {!last && <span className={`absolute left-1/2 top-3 -bottom-3 w-0.5 -translate-x-1/2 ${waiting ? "bg-neutral-300" : "bg-brand"}`} />}
              <span
                className={`absolute left-1/2 top-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                  waiting ? "size-2.5 bg-neutral-300" : current ? "size-3.5 bg-brand ring-4 ring-brand/20" : "size-2.5 bg-brand"
                }`}
              />
            </div>
            <div className={`flex min-w-0 flex-1 flex-col gap-0.5 ${last ? "" : compact ? "pb-4" : "pb-5"}`}>
              <p className={`leading-6 ${compact ? "text-sm" : "text-base"} ${current ? "font-medium" : ""} ${titleClass}`}>
                {item.title}
                {current && <span className="sr-only"> (terbaru)</span>}
                {waiting && <span className="sr-only"> (belum tercapai)</span>}
              </p>
              {(item.time || item.meta) && (
                <p className="break-words text-sm text-neutral-700">
                  {item.time && <time dateTime={item.time.toISOString()}>{formatDateTime(item.time)}</time>}
                  {item.meta && <span className="text-xs text-neutral-600">{item.time ? " · " : ""}{item.meta}</span>}
                </p>
              )}
              {item.description && <p className={`break-words text-sm ${current ? "text-neutral-900" : "text-neutral-600"}`}>{item.description}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
