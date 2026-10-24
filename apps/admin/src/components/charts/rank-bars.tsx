import type { ReactNode } from "react";
import { scaleBps } from "@/lib/overview/charts";
import { ChartCard, ChartTable } from "./chart-parts";

export interface RankDatum {
  key: string;
  label: string;
  /** What the bar length is (omzet, or a count). */
  value: number;
  /** Shown on the row, compact ("Rp 3,2 jt"). */
  valueText: string;
  /** The full value, for the table and the hover title ("Rp 3.250.000"). */
  fullValueText: string;
  /** Second line, e.g. "12 pcs, 40%". */
  detail?: string;
}

/** A horizontal bar of `value / max`, the bar alone (the row's text says the number). */
export function RankBar({ value, max }: { value: number; max: number }) {
  const width = scaleBps(value, max) / 100;
  return (
    <svg aria-hidden="true" viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2.5 w-full">
      <rect width={100} height={8} rx={1} className="fill-neutral-100" />
      {value > 0 && <rect width={Math.max(width, 1)} height={8} rx={1} className="fill-brand" />}
    </svg>
  );
}

/**
 * Ranked horizontal bars for categories (§4.1 RankBars; no pie charts, they are hard to read at
 * phone width). Label and value are text on every row, so nothing depends on colour; the bar is
 * the length to compare. Biggest first, as the data comes.
 */
export function RankBars({
  id,
  title,
  summary,
  data,
  headers,
  emptyText,
  testId,
  className,
}: {
  id: string;
  title: string;
  summary: ReactNode;
  data: readonly RankDatum[];
  /** Table headers: label, value, and detail when the rows have one. */
  headers: readonly string[];
  emptyText: string;
  testId?: string;
  className?: string;
}) {
  const max = Math.max(0, ...data.map((datum) => datum.value));
  return (
    <ChartCard id={id} title={title} summary={summary} testId={testId} className={className}>
      {data.length === 0 ? (
        <p className="text-sm text-neutral-600">{emptyText}</p>
      ) : (
        <>
          <ol aria-hidden="true" className="flex flex-col gap-3">
            {data.map((datum) => (
              <li key={datum.key} className="flex flex-col gap-1" title={`${datum.label}: ${datum.fullValueText}`} data-testid={testId ? `${testId}-row` : undefined}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium text-neutral-900">{datum.label}</span>
                  <span className="shrink-0 text-sm font-semibold text-neutral-900 tabular-nums">{datum.valueText}</span>
                </div>
                <RankBar value={datum.value} max={max} />
                {datum.detail && <span className="text-sm text-neutral-600 tabular-nums">{datum.detail}</span>}
              </li>
            ))}
          </ol>
          <ChartTable
            caption={title}
            headers={headers}
            rows={data.map((datum) => (datum.detail ? [datum.label, datum.fullValueText, datum.detail] : [datum.label, datum.fullValueText]))}
          />
        </>
      )}
    </ChartCard>
  );
}
