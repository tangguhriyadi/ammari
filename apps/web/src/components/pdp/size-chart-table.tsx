import type { StorefrontSizeChartRow } from "@ammari/db/storefront";

function heightLabel(row: StorefrontSizeChartRow): string {
  return row.heightRecommendationMinCm === row.heightRecommendationMaxCm
    ? `${row.heightRecommendationMinCm} cm`
    : `${row.heightRecommendationMinCm}–${row.heightRecommendationMaxCm} cm`;
}

/** docs/design/storefront.md §6 item 9 "Ukuran" — Ukuran / Lingkar dada / Panjang gamis / Panjang
 * lengan / Rekomendasi tinggi badan, horizontal scroll inside the accordion on small screens. */
export function SizeChartTable({ rows }: { rows: StorefrontSizeChartRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-line-strong text-ink-muted">
            <th className="py-2 pr-4 font-medium">Ukuran</th>
            <th className="py-2 pr-4 font-medium">Lingkar dada</th>
            <th className="py-2 pr-4 font-medium">Panjang gamis</th>
            <th className="py-2 pr-4 font-medium">Panjang lengan</th>
            <th className="py-2 font-medium">Rekomendasi tinggi badan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.size} className="border-b border-line">
              <td className="py-2 pr-4 font-medium text-ink">{row.size}</td>
              <td className="py-2 pr-4 text-ink-soft">{row.bustCm} cm</td>
              <td className="py-2 pr-4 text-ink-soft">{row.lengthCm} cm</td>
              <td className="py-2 pr-4 text-ink-soft">{row.sleeveLengthCm} cm</td>
              <td className="py-2 text-ink-soft">{heightLabel(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
