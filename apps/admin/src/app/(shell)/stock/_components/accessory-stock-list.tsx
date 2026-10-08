import Link from "next/link";
import { EmptyState } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { Size } from "@ammari/db/schema";

export interface AccessoryStockListRow {
  id: string;
  name: string;
  size: Size | null;
  qty: number;
  /** `null` for a session without finance.view_profit — stripped server-side by the page,
   * never just hidden client-side (same discipline as accessories/_components/accessory-list.tsx). */
  valueAmount: number | null;
}

export function AccessoryStockList({ rows }: { rows: AccessoryStockListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada aksesoris" description="Tambah aksesoris di menu Aksesoris untuk mulai mencatat stoknya." />;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const averageCost = row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
        return (
          <li key={row.id} className="rounded-lg border border-neutral-200 p-3">
            <Link href={`/stock/accessories/${row.id}`}>
              <p className="text-base text-neutral-900">
                {row.name}
                {row.size && <span className="ml-2 text-sm text-neutral-600">{row.size === "ALLSIZE" ? "Polos" : row.size}</span>}
              </p>
              <p className="text-sm text-neutral-600">
                {formatNumber(row.qty)} pcs
                {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/pcs</>}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
