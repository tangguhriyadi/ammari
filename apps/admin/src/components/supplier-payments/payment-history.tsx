import type { ReactNode } from "react";
import { Badge, Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { PAYMENT_METHOD_LABELS } from "@/lib/supplier-payments/messages";
import type { SupplierPaymentRow } from "@/lib/supplier-payments/payment-records";
import { voidSupplierPaymentAction } from "./actions";
import { PrivateFileLink } from "./private-file-link";
import { VoidRecordButton } from "./void-record-button";

// The "Riwayat pembayaran" list of a purchase or a batch (docs/plans/purchase-payments.md §9):
// a card per payment on phones, a table on tablet/desktop. Voided rows stay, struck through with
// "Dibatalkan" and the reason, and no longer count (P6). Rendered only for finance.view_profit
// (every figure is cost data); opening a proof and voiding additionally need
// supplier_payments.manage (`canRecord`).

export function voidedLine(row: { voidedAt: Date | null; voidedByName: string | null; voidReason: string | null }): string | null {
  if (!row.voidedAt) return null;
  return `Dibatalkan ${formatDateTime(row.voidedAt)}${row.voidedByName ? ` oleh ${row.voidedByName}` : ""}: ${row.voidReason ?? ""}`;
}

export function Struck({ voided, children }: { voided: boolean; children: ReactNode }) {
  return voided ? <span className="text-neutral-500 line-through">{children}</span> : <>{children}</>;
}

export function SummaryItem({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-base font-semibold tabular-nums text-neutral-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function PaymentHistory({ payments, canRecord }: { payments: SupplierPaymentRow[]; canRecord: boolean }) {
  if (payments.length === 0) return <p className="text-base text-neutral-600">Belum ada pembayaran.</p>;

  const proofCell = (payment: SupplierPaymentRow) =>
    canRecord ? <PrivateFileLink file={payment.proof} label="Lihat bukti" title={`Bukti ${payment.paymentNo}`} /> : <span className="text-neutral-600">-</span>;
  const voidButton = (payment: SupplierPaymentRow) =>
    canRecord && payment.voidedAt === null ? (
      <VoidRecordButton kind="payment" id={payment.id} label={payment.paymentNo} voidAction={voidSupplierPaymentAction} />
    ) : null;
  const payeeName = (payment: SupplierPaymentRow) => payment.supplierName ?? "Tanpa pemasok";

  return (
    <>
      <CardList>
        {payments.map((payment) => {
          const voided = payment.voidedAt !== null;
          return (
            <li key={payment.id} data-testid="payment-card">
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-neutral-900">
                      <Struck voided={voided}>{payment.paymentNo}</Struck>
                    </p>
                    <p className="text-sm text-neutral-600">
                      {formatDate(new Date(payment.paidAt))} · {PAYMENT_METHOD_LABELS[payment.method]}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-base font-semibold tabular-nums text-neutral-900">
                      <Struck voided={voided}>{formatRupiah(payment.amount)}</Struck>
                    </span>
                    {voided && <Badge variant="neutral">Dibatalkan</Badge>}
                  </div>
                </div>
                <p className="text-sm text-neutral-600">
                  Kepada {payeeName(payment)} · dicatat {formatDateTime(payment.createdAt)}
                  {payment.recordedByName ? ` oleh ${payment.recordedByName}` : ""}
                </p>
                {payment.note && <p className="text-sm text-neutral-800">{payment.note}</p>}
                {voided && <p className="text-sm text-neutral-700">{voidedLine(payment)}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {proofCell(payment)}
                  {voidButton(payment)}
                </div>
              </Card>
            </li>
          );
        })}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>No. bayar</Th>
          <Th>Tanggal</Th>
          <Th>Metode</Th>
          <Th>Jumlah</Th>
          <Th>Dibayar kepada</Th>
          <Th>Dicatat oleh</Th>
          <Th>Bukti</Th>
          <Th>Catatan</Th>
          {canRecord && <Th>Aksi</Th>}
        </TableHead>
        <tbody>
          {payments.map((payment) => {
            const voided = payment.voidedAt !== null;
            return (
              <Tr key={payment.id} data-testid="payment-row">
                <Td className="font-medium text-neutral-900">
                  <div className="flex flex-col items-start gap-1">
                    <Struck voided={voided}>{payment.paymentNo}</Struck>
                    {voided && <Badge variant="neutral">Dibatalkan</Badge>}
                  </div>
                </Td>
                <Td className="text-neutral-700">{formatDate(new Date(payment.paidAt))}</Td>
                <Td className="text-neutral-700">{PAYMENT_METHOD_LABELS[payment.method]}</Td>
                <Td className="tabular-nums text-neutral-900">
                  <Struck voided={voided}>{formatRupiah(payment.amount)}</Struck>
                </Td>
                <Td className="text-neutral-700">{payeeName(payment)}</Td>
                <Td className="text-neutral-700">
                  {payment.recordedByName ?? "-"}
                  <span className="block text-sm text-neutral-600">{formatDateTime(payment.createdAt)}</span>
                </Td>
                <Td>{proofCell(payment)}</Td>
                <Td className="max-w-64 text-neutral-700">
                  {payment.note ?? (voided ? null : "-")}
                  {voided && <span className="block text-sm text-neutral-700">{voidedLine(payment)}</span>}
                </Td>
                {canRecord && <Td>{voidButton(payment)}</Td>}
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>
    </>
  );
}
