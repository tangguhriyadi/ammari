import { axisLabelStep, niceScale, scaleBps } from "@/lib/overview/charts";
import { ChartLegend, ChartTable, GridLines, XAxisLabels, YAxisLabels } from "./chart-parts";

export interface CumulativeDatum {
  key: string;
  /** "November 2026", for the table. */
  label: string;
  /** "Nov", under the axis. */
  axisLabel: string;
  /** The target line at the month's end. */
  expected: number;
  /** Actual so far; null for a month not started. */
  actual: number | null;
}

const STEP = 10;

/**
 * Cumulative actual (solid brand line with dots) against the straight-line target (dashed black
 * line) per month (§2.3, §4.1 CumulativeLine). Line style, not only colour, tells the two apart,
 * and the legend names them. Sits inside the target card, so it is a bare <figure>.
 */
export function CumulativeLine({
  id,
  title,
  summary,
  data,
  formatValue,
  formatTick,
}: {
  id: string;
  title: string;
  summary: string;
  data: readonly CumulativeDatum[];
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
}) {
  const scale = niceScale(Math.max(0, ...data.map((datum) => Math.max(datum.expected, datum.actual ?? 0))));
  // Each month is a column, its point at the column's middle, so the points line up with the
  // x-axis labels (centred in the same columns).
  const width = data.length * STEP;
  const x = (index: number) => (index + 0.5) * STEP;
  const y = (value: number) => 100 - scaleBps(value, scale.max) / 100;
  const expectedPoints = data.map((datum, index) => `${x(index)},${y(datum.expected)}`).join(" ");
  const actual = data.flatMap((datum, index) => (datum.actual === null ? [] : [{ index, value: datum.actual }]));
  const actualPoints = actual.map((point) => `${x(point.index)},${y(point.value)}`).join(" ");

  return (
    <figure id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3 border-t border-neutral-200 pt-4" data-testid="overview-target-cumulative">
      <figcaption className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-base font-semibold text-neutral-900">
          {title}
        </h3>
        <p className="text-pretty text-sm text-neutral-600">{summary}</p>
      </figcaption>
      <div className="flex flex-col gap-2">
        <div aria-hidden="true" className="flex h-36 gap-2 pt-2">
          <YAxisLabels scale={scale} formatTick={formatTick} />
          <div className="relative min-w-0 flex-1">
            <div className="relative h-full">
              <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
                <GridLines scale={scale} width={width} />
                <polyline points={expectedPoints} fill="none" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="stroke-black" />
                {actual.length > 1 && <polyline points={actualPoints} fill="none" strokeWidth={3} vectorEffect="non-scaling-stroke" className="stroke-brand" />}
              </svg>
              {actual.map((point) => (
                <span
                  key={point.index}
                  className="absolute size-2.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white bg-brand"
                  style={{ left: `${((point.index + 0.5) / data.length) * 100}%`, bottom: `${scaleBps(point.value, scale.max) / 100}%` }}
                  title={`${data[point.index]?.label}: ${formatValue(point.value)}`}
                />
              ))}
            </div>
          </div>
        </div>
        <XAxisLabels labels={data.map((datum) => datum.axisLabel)} step={axisLabelStep(data.length)} />
        <ChartLegend
          items={[
            { kind: "line", label: "Omzet kumulatif" },
            { kind: "dashed", label: "Target garis lurus" },
          ]}
        />
      </div>
      <ChartTable
        caption={title}
        headers={["Bulan", "Omzet kumulatif", "Target kumulatif"]}
        rows={data.map((datum) => [datum.label, datum.actual === null ? "Belum berjalan" : formatValue(datum.actual), formatValue(datum.expected)])}
      />
    </figure>
  );
}
