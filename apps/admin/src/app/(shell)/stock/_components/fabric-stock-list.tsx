import Link from "next/link";
import { EmptyState } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";

export interface FabricStockListRow {
  id: string;
  name: string;
  supplier: string | null;
  qty: number;
  /** `null` for a session without finance.view_profit — stripped server-side by the page. */
  valueAmount: number | null;
}

export function FabricStockList({ rows }: { rows: FabricStockListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada bahan" description="Tambah bahan di menu Bahan untuk mulai mencatat stoknya." />;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const averageCost = row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
        return (
          <li key={row.id} className="rounded-lg border border-neutral-200 p-3">
            <Link href={`/stock/fabrics/${row.id}`}>
              <p className="text-base text-neutral-900">{row.name}</p>
              <p className="text-sm text-neutral-600">
                {row.supplier ? `${row.supplier} · ` : ""}
                {row.qty.toFixed(2)} yard
                {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/yard</>}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
