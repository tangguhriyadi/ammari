import Link from "next/link";
import { Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
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

function averageCostOf(row: AccessoryStockListRow): number | null {
  return row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
}

export function AccessoryStockList({ rows }: { rows: AccessoryStockListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada aksesoris" description="Tambah aksesoris di menu Aksesoris untuk mulai mencatat stoknya." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => {
          const averageCost = averageCostOf(row);
          return (
            <li key={row.id}>
              <Link href={`/stock/accessories/${row.id}`}>
                <Card className="flex flex-col gap-1">
                  <p className="text-base text-neutral-900">
                    {row.name}
                    {row.size && <span className="ml-2 text-sm text-neutral-600">{row.size === "ALLSIZE" ? "Polos" : row.size}</span>}
                  </p>
                  <p className="text-sm text-neutral-600">
                    {formatNumber(row.qty)} pcs
                    {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/pcs</>}
                  </p>
                </Card>
              </Link>
            </li>
          );
        })}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Stok</Th>
          <Th>Harga rata-rata</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const averageCost = averageCostOf(row);
            return (
              <Tr key={row.id}>
                <Td>
                  <Link href={`/stock/accessories/${row.id}`} className="font-medium text-brand hover:underline">
                    {row.name}
                  </Link>
                  {row.size && <span className="ml-2 text-neutral-600">{row.size === "ALLSIZE" ? "Polos" : row.size}</span>}
                </Td>
                <Td className="text-neutral-700 tabular-nums">{formatNumber(row.qty)} pcs</Td>
                <Td className="text-neutral-700 tabular-nums">{averageCost !== null ? `${formatRupiah(averageCost)}/pcs` : "—"}</Td>
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>
    </>
  );
}
