import Link from "next/link";
import { Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { PurchaseListRow } from "@/lib/inventory/purchases";

const ITEM_TYPE_LABELS: Record<PurchaseListRow["itemType"], string> = { fabric: "Kain", accessory: "Aksesoris" };

function qtyLabel(row: PurchaseListRow): string {
  return row.itemType === "fabric" ? `${row.qty.toFixed(2)} yard` : `${row.qty} pcs`;
}

export function PurchaseList({ rows }: { rows: PurchaseListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pembelian" description="Catat pembelian bahan atau aksesoris pertama." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/purchases/${row.id}`}>
              <Card className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-base text-neutral-900">
                    {row.itemName}
                    <span className="ml-2 text-sm text-neutral-600">{ITEM_TYPE_LABELS[row.itemType]}</span>
                    {row.voidedAt !== null && (
                      <span className="ml-2">
                        <Badge variant="neutral">Dibatalkan</Badge>
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-600">
                    {formatDate(new Date(row.purchasedAt))}
                    {row.supplier ? ` · ${row.supplier}` : ""}
                    {" · "}
                    {qtyLabel(row)}
                  </p>
                </div>
                {row.totalAmountPaid !== null && (
                  <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.totalAmountPaid)}</span>
                )}
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Item</Th>
          <Th>Tanggal</Th>
          <Th>Pemasok</Th>
          <Th>Jumlah</Th>
          <Th>Total dibayar</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <Link href={`/purchases/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.itemName}
                </Link>
                <span className="ml-2 text-neutral-600">{ITEM_TYPE_LABELS[row.itemType]}</span>
              </Td>
              <Td className="text-neutral-700">{formatDate(new Date(row.purchasedAt))}</Td>
              <Td className="text-neutral-700">{row.supplier ?? "—"}</Td>
              <Td className="text-neutral-700 tabular-nums">{qtyLabel(row)}</Td>
              <Td className="text-neutral-700 tabular-nums">
                {row.totalAmountPaid !== null ? formatRupiah(row.totalAmountPaid) : "—"}
              </Td>
              <Td>{row.voidedAt !== null ? <Badge variant="neutral">Dibatalkan</Badge> : null}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
