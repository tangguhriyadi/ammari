import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import { VOUCHER_STATUS_BADGE } from "@/lib/customers/labels";
import { VOUCHER_STATUS_LABELS } from "@/lib/vouchers/status";
import type { VoucherListRow } from "@/lib/vouchers/overview";

// A voucher list on the Voucher tab ("Segera berakhir" and "Semua voucher", docs/plans/growth.md
// §9.2): customer name (linking to the detail, where the actions live), amount, effective status
// and dates. No contact data. Read-only (A12: nothing is sent from the admin).

export function VoucherStatusBadge({ status, expiringSoon }: { status: VoucherListRow["status"]; expiringSoon: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={VOUCHER_STATUS_BADGE[status]}>{VOUCHER_STATUS_LABELS[status]}</Badge>
      {expiringSoon && <Badge variant="warning">Segera berakhir</Badge>}
    </span>
  );
}

export function VoucherList({ rows, testId, emptyTitle, emptyDescription }: { rows: VoucherListRow[]; testId: string; emptyTitle: string; emptyDescription: string }) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid={`${testId}-card`}>
            <Card className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/customers/${row.customerId}`} className="text-base font-medium text-brand hover:underline">
                  {row.customerName}
                </Link>
                <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.amount)}</span>
              </div>
              <VoucherStatusBadge status={row.status} expiringSoon={row.expiringSoon} />
              <p className="text-sm text-neutral-600">
                Berlaku sampai {formatDate(row.expiresAt)} · terbit {formatDate(row.issuedAt)}
                {row.usedOrder ? ` · dipakai di ${row.usedOrder.orderNo}` : ""}
              </p>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Pelanggan</Th>
          <Th className="text-right">Nilai</Th>
          <Th>Status</Th>
          <Th>Terbit</Th>
          <Th>Berlaku sampai</Th>
          <Th>Dipakai di</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid={`${testId}-row`}>
              <Td className="font-medium">
                <Link href={`/customers/${row.customerId}`} className="text-brand hover:underline">
                  {row.customerName}
                </Link>
              </Td>
              <Td className="text-right tabular-nums">{formatRupiah(row.amount)}</Td>
              <Td>
                <VoucherStatusBadge status={row.status} expiringSoon={row.expiringSoon} />
              </Td>
              <Td className="whitespace-nowrap text-neutral-700">{formatDate(row.issuedAt)}</Td>
              <Td className="whitespace-nowrap text-neutral-700">{formatDate(row.expiresAt)}</Td>
              <Td className="text-neutral-700">{row.usedOrder?.orderNo ?? "-"}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
