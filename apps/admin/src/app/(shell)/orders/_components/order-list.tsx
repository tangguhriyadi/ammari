import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import type { OrderListRow } from "@/lib/orders/queries";
import { ORDER_STATUS_BADGE_VARIANT, ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";

function buyerLabel(row: OrderListRow): string {
  return row.customerName ?? row.buyerUsername ?? "—";
}

export function OrderList({ rows }: { rows: OrderListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pesanan" description="Catat pesanan manual pertama, atau tunggu pesanan masuk dari impor." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/orders/${row.id}`}>
              <Card className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-base text-neutral-900">
                    {row.orderNo}
                    <span className="ml-2 text-sm text-neutral-600">{row.channelName}</span>
                  </p>
                  <p className="text-sm text-neutral-600">
                    {formatDate(new Date(row.orderDate))} · {buyerLabel(row)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.totalAmount)}</span>
                  <Badge variant={ORDER_STATUS_BADGE_VARIANT[row.status]}>{ORDER_STATUS_LABELS[row.status]}</Badge>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>No. Pesanan</Th>
          <Th>Kanal</Th>
          <Th>Tanggal</Th>
          <Th>Pelanggan</Th>
          <Th>Total</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <Link href={`/orders/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.orderNo}
                </Link>
              </Td>
              <Td className="text-neutral-700">{row.channelName}</Td>
              <Td className="text-neutral-700">{formatDate(new Date(row.orderDate))}</Td>
              <Td className="text-neutral-700">{buyerLabel(row)}</Td>
              <Td className="text-neutral-700 tabular-nums">{formatRupiah(row.totalAmount)}</Td>
              <Td>
                <Badge variant={ORDER_STATUS_BADGE_VARIANT[row.status]}>{ORDER_STATUS_LABELS[row.status]}</Badge>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
