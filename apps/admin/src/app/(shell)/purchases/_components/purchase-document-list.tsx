import Link from "next/link";
import { Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { PurchaseDocumentListRow } from "@/lib/purchases/queries";
import { PurchaseStatusBadge } from "./purchase-status-badge";

export function PurchaseDocumentList({ rows }: { rows: PurchaseDocumentListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pesanan pembelian" description="Buat pesanan pembelian bahan atau aksesoris pertama." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/purchases/${row.id}`}>
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-neutral-900">{row.purchaseNo}</p>
                    <p className="truncate text-sm text-neutral-600">{row.supplierName}</p>
                  </div>
                  <PurchaseStatusBadge status={row.status} />
                </div>
                <div className="flex items-center justify-between gap-3 text-sm text-neutral-600">
                  <span>
                    {formatDate(new Date(row.orderedAt))} · {row.itemCount} barang
                  </span>
                  {row.totalAmountPaid !== null && (
                    <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.totalAmountPaid)}</span>
                  )}
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>No. pesanan</Th>
          <Th>Supplier</Th>
          <Th>Tanggal pesan</Th>
          <Th>Barang</Th>
          <Th>Total</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <Link href={`/purchases/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.purchaseNo}
                </Link>
              </Td>
              <Td className="text-neutral-700">{row.supplierName}</Td>
              <Td className="text-neutral-700">{formatDate(new Date(row.orderedAt))}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.itemCount}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.totalAmountPaid !== null ? formatRupiah(row.totalAmountPaid) : "-"}</Td>
              <Td>
                <PurchaseStatusBadge status={row.status} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
