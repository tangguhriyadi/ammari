import type { ReactNode } from "react";
import { axisLabelStep, niceScale, scaleBps } from "@/lib/overview/charts";
import { ChartCard, ChartLegend, ChartTable, GridLines, XAxisLabels, YAxisLabels, type SwatchKind } from "./chart-parts";

export interface BarDatum {
  key: string;
  /** Full label, for the table and the hover title ("23 Okt 2026"). */
  label: string;
  /** Short label under the bar ("23"). */
  axisLabel: string;
  value: number;
  /** In the selected period (brand) or the days before it shown for context (muted). */
  tone: "selected" | "context";
  /** Still running (today, or this month): hatched, so it does not read as a bad day. */
  partial?: boolean;
}

/** Each bar's slot in viewBox units; the bar takes the middle 70%. */
const SLOT = 10;
const BAR = 7;

/**
 * Vertical bars over time (§4.1 BarChart). The SVG stretches to the card (preserveAspectRatio
 * "none") and holds only rectangles and lines; every label is HTML so it stays readable at 390px.
 * Hovering a bar on desktop shows its value (native SVG <title>).
 */
export function BarChart({
  id,
  title,
  summary,
  actions,
  data,
  formatValue,
  formatTick,
  integer = false,
  labelHeader,
  valueHeader,
  footnote,
  testId,
  className,
}: {
  id: string;
  title: string;
  summary: ReactNode;
  actions?: ReactNode;
  data: readonly BarDatum[];
  /** Full value, for the table and the hover title. */
  formatValue: (value: number) => string;
  /** Compact axis value. */
  formatTick: (value: number) => string;
  /** Counts: whole-number ticks. */
  integer?: boolean;
  labelHeader: string;
  valueHeader: string;
  footnote?: ReactNode;
  testId?: string;
  className?: string;
}) {
  const scale = niceScale(Math.max(0, ...data.map((datum) => datum.value)), { integer });
  const width = data.length * SLOT;
  const hatchId = `${id}-hatch`;
  const legend: { kind: SwatchKind; label: string }[] = [];
  if (data.some((datum) => datum.tone === "context")) {
    legend.push({ kind: "solid", label: "Periode dipilih" }, { kind: "muted", label: "Hari sebelumnya" });
  }
  if (data.some((datum) => datum.partial)) legend.push({ kind: "hatched", label: "Belum penuh (masih berjalan atau sebagian)" });

  return (
    <ChartCard id={id} title={title} summary={summary} actions={actions} testId={testId} className={className}>
      <div className="flex flex-col gap-2">
        <div aria-hidden="true" className="flex h-44 gap-2 pt-2">
          <YAxisLabels scale={scale} formatTick={formatTick} />
          <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" className="h-full min-w-0 flex-1 overflow-visible">
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width={3} height={3} patternTransform="rotate(45)">
                <rect width={3} height={3} className="fill-neutral-200" />
                <rect width={1.4} height={3} className="fill-brand" />
              </pattern>
            </defs>
            <GridLines scale={scale} width={width} />
            {data.map((datum, index) => {
              const heightBps = scaleBps(datum.value, scale.max);
              // A day with sales is never invisible next to a big one.
              const height = datum.value > 0 ? Math.max(heightBps / 100, 1) : 0;
              return (
                <rect
                  key={datum.key}
                  x={index * SLOT + (SLOT - BAR) / 2}
                  width={BAR}
                  y={100 - height}
                  height={height}
                  className={datum.partial ? undefined : datum.tone === "selected" ? "fill-brand" : "fill-neutral-300"}
                  fill={datum.partial ? `url(#${hatchId})` : undefined}
                  data-testid={testId ? `${testId}-bar` : undefined}
                  data-value={datum.value}
                >
                  <title>{`${datum.label}: ${formatValue(datum.value)}`}</title>
                </rect>
              );
            })}
          </svg>
        </div>
        <XAxisLabels labels={data.map((datum) => datum.axisLabel)} step={axisLabelStep(data.length)} emphasizeLast={data.at(-1)?.tone === "selected"} />
        {footnote && <p className="ml-16 text-sm text-neutral-600">{footnote}</p>}
        <ChartLegend items={legend} />
      </div>
      <ChartTable
        caption={title}
        headers={[labelHeader, valueHeader]}
        rows={data.map((datum) => [
          `${datum.label}${datum.partial ? " (belum penuh)" : datum.tone === "context" ? " (sebelum periode)" : ""}`,
          formatValue(datum.value),
        ])}
      />
    </ChartCard>
  );
}
