import Link from "next/link";
import { Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { PurchaseDocumentListRow } from "@/lib/purchases/queries";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";
import { PurchaseStatusBadge } from "./purchase-status-badge";

/** "Sisa" (or "Lebih bayar") for a finance viewer; null when the amounts were stripped (A8). */
function balanceText(payment: PurchaseDocumentListRow["payment"], remainingPrefix: string): string | null {
  if (!("tagihan" in payment)) return null;
  if (payment.overpaid > 0) return `Lebih bayar ${formatRupiah(payment.overpaid)}`;
  return payment.remaining > 0 ? `${remainingPrefix}${formatRupiah(payment.remaining)}` : null;
}

function CardBalance({ payment }: { payment: PurchaseDocumentListRow["payment"] }) {
  const text = balanceText(payment, "Sisa ");
  return text ? <span className="tabular-nums">{text}</span> : null;
}

export function PurchaseDocumentList({ rows }: { rows: PurchaseDocumentListRow[] }) {
  const showBalance = rows.some((row) => "tagihan" in row.payment);
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
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600">
                  <span className="flex items-center gap-2">
                    Pembayaran <PaymentStatusBadge status={row.payment.status} />
                  </span>
                  <CardBalance payment={row.payment} />
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
          <Th>Pembayaran</Th>
          {showBalance && <Th>Sisa</Th>}
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
              <Td>
                <PaymentStatusBadge status={row.payment.status} />
              </Td>
              {showBalance && <Td className="text-neutral-700 tabular-nums">{balanceText(row.payment, "") ?? "-"}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
