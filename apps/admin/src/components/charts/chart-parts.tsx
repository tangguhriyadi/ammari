import type { ReactNode } from "react";
import { Card } from "@ammari/ui";
import { scaleBps, type AxisScale } from "@/lib/overview/charts";

// Shared pieces of the Ringkasan charts (docs/plans/dashboard-overview.md §4.1, D7): server-rendered,
// no client JS. Every chart is a <figure> with a heading, a one-line text summary, the drawing
// (aria-hidden: it repeats the table) and a visually hidden <table> with every number, so a screen
// reader gets the data and colour is never the only way to read it.

export function ChartCard({
  id,
  title,
  summary,
  actions,
  children,
  testId,
  className,
}: {
  id: string;
  title: string;
  summary: ReactNode;
  /** A switch next to the title (e.g. Omzet / Pesanan). */
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <Card className={className} data-testid={testId}>
      <figure id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-20 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <figcaption className="flex min-w-0 flex-col gap-1">
            <h3 id={`${id}-title`} className="text-base font-semibold text-neutral-900">
              {title}
            </h3>
            <p className="text-pretty text-sm text-neutral-600" data-testid={testId ? `${testId}-summary` : undefined}>
              {summary}
            </p>
          </figcaption>
          {actions}
        </div>
        {children}
      </figure>
    </Card>
  );
}

/** A visually hidden data table: what the drawing shows, as text. The wrapper is what is hidden:
 * `sr-only` on a <table> itself does not clip it (a table box ignores width and overflow), so a wide
 * one would still widen the page. */
export function ChartTable({ caption, headers, rows }: { caption: string; headers: readonly string[]; rows: readonly (readonly string[])[] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, ...cells], index) => (
            <tr key={`${label}-${index}`}>
              <th scope="row">{label}</th>
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Y-axis tick labels in HTML next to a stretched SVG: SVG text would shrink with the drawing and
 * be unreadable at 390px. */
export function YAxisLabels({ scale, formatTick }: { scale: AxisScale; formatTick: (value: number) => string }) {
  return (
    <div className="relative w-14 shrink-0 text-right text-sm text-neutral-600 tabular-nums">
      {scale.ticks.map((tick) => (
        <span key={tick} className="absolute right-0 translate-y-1/2 leading-none whitespace-nowrap" style={{ bottom: `${scaleBps(tick, scale.max) / 100}%` }}>
          {formatTick(tick)}
        </span>
      ))}
    </div>
  );
}

/** Horizontal grid lines at each tick, inside an SVG of viewBox height 100. */
export function GridLines({ scale, width }: { scale: AxisScale; width: number }) {
  return (
    <>
      {scale.ticks.map((tick) => {
        const y = 100 - scaleBps(tick, scale.max) / 100;
        return (
          <line
            key={tick}
            x1={0}
            x2={width}
            y1={y}
            y2={y}
            className={tick === 0 ? "stroke-neutral-400" : "stroke-neutral-200"}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </>
  );
}

/** X-axis labels under a chart of `labels.length` equal columns, every `step`-th one counted from
 * the LAST, so the newest bar (today, or the selected day) is always labelled. */
export function XAxisLabels({ labels, step, emphasizeLast = false }: { labels: readonly string[]; step: number; emphasizeLast?: boolean }) {
  return (
    <div aria-hidden="true" className="ml-16 grid text-sm text-neutral-600 tabular-nums" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
      {labels.map((label, index) => {
        const shown = (labels.length - 1 - index) % step === 0;
        const isLast = index === labels.length - 1;
        return (
          <span key={`${label}-${index}`} className={`flex justify-center whitespace-nowrap ${isLast && emphasizeLast ? "font-semibold text-neutral-900" : ""}`}>
            {shown ? label : ""}
          </span>
        );
      })}
    </div>
  );
}

export type SwatchKind = "solid" | "muted" | "hatched" | "line" | "dashed";

function Swatch({ kind }: { kind: SwatchKind }) {
  if (kind === "line" || kind === "dashed") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 4" className="h-1 w-5 shrink-0">
        <line x1={0} x2={20} y1={2} y2={2} strokeWidth={3} className={kind === "line" ? "stroke-brand" : "stroke-black"} strokeDasharray={kind === "dashed" ? "4 3" : undefined} />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
      {kind === "hatched" ? (
        <>
          <rect width={12} height={12} className="fill-neutral-200" />
          {[0, 4, 8, 12, 16].map((offset) => (
            <line key={offset} x1={offset} y1={0} x2={offset - 12} y2={12} strokeWidth={2} className="stroke-brand" />
          ))}
        </>
      ) : (
        <rect width={12} height={12} rx={2} className={kind === "solid" ? "fill-brand" : "fill-neutral-300"} />
      )}
    </svg>
  );
}

/** What each colour, pattern or line style means, in words. */
export function ChartLegend({ items }: { items: readonly { kind: SwatchKind; label: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-600">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <Swatch kind={item.kind} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
