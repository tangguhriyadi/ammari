import type { StorefrontSizeChartRow } from "@ammari/db/storefront";
import { SIZE_CHART_HEADING_ID } from "./size-guide";

function heightLabel(row: StorefrontSizeChartRow): string {
  return row.heightRecommendationMinCm === row.heightRecommendationMaxCm
    ? `${row.heightRecommendationMinCm} cm`
    : `${row.heightRecommendationMinCm}–${row.heightRecommendationMaxCm} cm`;
}

// The Ukuran column stays pinned while the rest scrolls under it: it needs its own background
// (the cells behind would show through otherwise) and its own right edge, since the table's
// collapsed borders don't travel with a sticky cell.
const STICKY_CELL = "sticky left-0 z-10 bg-bg py-2 pr-4 shadow-[1px_0_0_var(--color-line)]";

/** docs/design/storefront.md §6 item 9 "Ukuran" — Ukuran / Lingkar dada / Panjang gamis / Panjang
 * lengan / Rekomendasi tinggi badan, horizontal scroll inside the accordion on small screens
 * (only the table scrolls, never the page: see `.curtain-clip` in globals.css). */
export function SizeChartTable({ rows }: { rows: StorefrontSizeChartRow[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Landing target of the PDP's "Panduan ukuran" link (accordions.tsx scrolls and focuses here). */}
      <h3 id={SIZE_CHART_HEADING_ID} tabIndex={-1} className="scroll-mt-20 text-xs font-medium text-ink outline-none">
        Panduan ukuran
      </h3>
      {/* Focusable so keyboard users can scroll it too (a scrollable region with no focusable
          content inside is otherwise unreachable). */}
      <div data-testid="size-chart-scroll" tabIndex={0} role="region" aria-label="Tabel panduan ukuran" className="overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink">
        <SizeChartTableBody rows={rows} />
      </div>
      {/* The table's min width only overflows below `sm`; from there every column fits. */}
      <p className="text-xs text-ink-muted sm:hidden" aria-hidden="true">
        Geser tabel ke samping untuk melihat semua kolom.
      </p>
    </div>
  );
}

function SizeChartTableBody({ rows }: { rows: StorefrontSizeChartRow[] }) {
  return (
    <table className="w-full min-w-[480px] border-collapse text-left text-xs">
      <thead>
        <tr className="border-b border-line-strong text-ink-muted">
          <th scope="col" className={`${STICKY_CELL} font-medium`}>
            Ukuran
          </th>
          <th scope="col" className="py-2 pr-4 pl-4 font-medium">Lingkar dada</th>
          <th scope="col" className="py-2 pr-4 font-medium">Panjang gamis</th>
          <th scope="col" className="py-2 pr-4 font-medium">Panjang lengan</th>
          <th scope="col" className="py-2 font-medium">Rekomendasi tinggi badan</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.size} className="border-b border-line">
            <th scope="row" className={`${STICKY_CELL} font-medium text-ink`}>
              {row.size}
            </th>
            <td className="py-2 pr-4 pl-4 text-ink-soft">{row.bustCm} cm</td>
            <td className="py-2 pr-4 text-ink-soft">{row.lengthCm} cm</td>
            <td className="py-2 pr-4 text-ink-soft">{row.sleeveLengthCm} cm</td>
            <td className="py-2 text-ink-soft">{heightLabel(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
