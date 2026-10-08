import Link from "next/link";
import { Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";

export interface FabricStockListRow {
  id: string;
  name: string;
  supplier: string | null;
  qty: number;
  /** `null` for a session without finance.view_profit — stripped server-side by the page. */
  valueAmount: number | null;
}

function averageCostOf(row: FabricStockListRow): number | null {
  return row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
}

export function FabricStockList({ rows }: { rows: FabricStockListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada bahan" description="Tambah bahan di menu Bahan untuk mulai mencatat stoknya." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => {
          const averageCost = averageCostOf(row);
          return (
            <li key={row.id}>
              <Link href={`/stock/fabrics/${row.id}`}>
                <Card className="flex flex-col gap-1">
                  <p className="text-base text-neutral-900">{row.name}</p>
                  <p className="text-sm text-neutral-600">
                    {row.supplier ? `${row.supplier} · ` : ""}
                    {row.qty.toFixed(2)} yard
                    {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/yard</>}
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
          <Th>Pemasok</Th>
          <Th>Stok</Th>
          <Th>Harga rata-rata</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const averageCost = averageCostOf(row);
            return (
              <Tr key={row.id}>
                <Td>
                  <Link href={`/stock/fabrics/${row.id}`} className="font-medium text-brand hover:underline">
                    {row.name}
                  </Link>
                </Td>
                <Td className="text-neutral-700">{row.supplier ?? "—"}</Td>
                <Td className="text-neutral-700 tabular-nums">{row.qty.toFixed(2)} yard</Td>
                <Td className="text-neutral-700 tabular-nums">{averageCost !== null ? `${formatRupiah(averageCost)}/yard` : "—"}</Td>
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>
    </>
  );
}
