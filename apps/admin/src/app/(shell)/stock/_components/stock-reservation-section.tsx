import Link from "next/link";
import { Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import type { ActiveReservationRow } from "@/lib/stock/queries";

/** "Dipesan" on the SKU detail page (docs/plans/cart-checkout.md §7): the unpaid web checkout
 * orders currently holding this SKU. Read-only, and rendered only while a hold exists, so a SKU
 * that was never ordered online looks exactly as before. The order number links to the order only
 * when the session can open it (orders.view). */
export function StockReservationSection({ rows, canOpenOrders }: { rows: ActiveReservationRow[]; canOpenOrders: boolean }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.qty, 0);

  const orderLabel = (row: ActiveReservationRow) =>
    canOpenOrders ? (
      <Link href={`/orders/${row.orderId}`} className="font-medium text-brand hover:underline">
        {row.orderNo}
      </Link>
    ) : (
      row.orderNo
    );

  return (
    <section aria-labelledby="stock-reservation-heading" className="mb-8 flex flex-col gap-3" data-testid="stock-reservation-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="stock-reservation-heading" className="text-lg font-semibold text-neutral-900">
          Ditahan untuk pesanan web
        </h2>
        <p className="text-base text-neutral-900">
          Dipesan <span className="font-semibold tabular-nums">{formatNumber(total)} pcs</span>
        </p>
      </div>
      <p className="text-sm text-neutral-600">
        Pesanan web yang belum dibayar. Barangnya masih di rak dan masih termasuk stok. Kalau tidak dibayar sampai batas waktu,
        stok bisa dijual lagi.
      </p>

      <CardList>
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="flex items-center justify-between gap-3">
              <div>
                <p className="text-base text-neutral-900">{orderLabel(row)}</p>
                <p className="text-sm text-neutral-600">Dipesan {formatDateTime(row.createdAt)}</p>
                <p className="text-sm text-neutral-600">Ditahan sampai {formatDateTime(row.expiresAt)}</p>
              </div>
              <span className="text-base font-semibold tabular-nums text-neutral-900">{formatNumber(row.qty)} pcs</span>
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Pesanan</Th>
          <Th>Dipesan pada</Th>
          <Th>Ditahan sampai</Th>
          <Th>Qty</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="text-neutral-900">{orderLabel(row)}</Td>
              <Td className="text-neutral-700">{formatDateTime(row.createdAt)}</Td>
              <Td className="text-neutral-700">{formatDateTime(row.expiresAt)}</Td>
              <Td className="tabular-nums font-medium text-neutral-900">{formatNumber(row.qty)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </section>
  );
}
