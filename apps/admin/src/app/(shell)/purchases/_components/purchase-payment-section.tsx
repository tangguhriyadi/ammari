import type { ReactNode } from "react";
import { Badge, Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import {
  PAYMENT_METHOD_LABELS,
  type PurchaseAttachmentRow,
  type PurchasePaymentRow,
} from "@/lib/supplier-payments/purchase-payments";
import type { PaymentSummary } from "@/lib/supplier-payments/status";
import { AttachInvoiceButton } from "./attach-invoice-button";
import { PaymentStatusBadge } from "./payment-status-badge";
import { PrivateFileLink } from "./private-file-link";
import { RecordPaymentButton } from "./record-payment-button";
import { VoidRecordButton } from "./void-record-button";

// The purchase detail's "Pembayaran" and "Nota pemasok" sections (docs/plans/purchase-payments.md
// §9). Rendered only for finance.view_profit (the page decides; §7): every figure here is cost
// data. Recording, voiding and opening a proof additionally need supplier_payments.manage.

function voidedLine(row: { voidedAt: Date | null; voidedByName: string | null; voidReason: string | null }): string | null {
  if (!row.voidedAt) return null;
  return `Dibatalkan ${formatDateTime(row.voidedAt)}${row.voidedByName ? ` oleh ${row.voidedByName}` : ""}: ${row.voidReason ?? ""}`;
}

function SummaryItem({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-base font-semibold tabular-nums text-neutral-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function PurchasePaymentSection({
  purchaseId,
  purchaseNo,
  isCancelled,
  summary,
  payments,
  canRecord,
}: {
  purchaseId: string;
  purchaseNo: string;
  isCancelled: boolean;
  summary: PaymentSummary;
  payments: PurchasePaymentRow[];
  /** supplier_payments.manage (+ finance.view_profit, implied by this section rendering at all):
   * record, void, open proofs. */
  canRecord: boolean;
}) {
  const canPay = canRecord && !isCancelled && summary.remaining > 0;
  return (
    <section aria-labelledby="payments-heading" className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="payments-heading" className="text-lg font-semibold text-neutral-900">
          Pembayaran
        </h2>
        {canPay && <RecordPaymentButton purchaseId={purchaseId} purchaseNo={purchaseNo} remaining={summary.remaining} />}
      </div>

      <Card className="flex flex-col gap-3" data-testid="payment-summary">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-neutral-600">Status pembayaran</span>
          <PaymentStatusBadge status={summary.status} />
        </div>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <SummaryItem label="Tagihan" value={formatRupiah(summary.tagihan)} testId="payment-tagihan" />
          <SummaryItem label="Dibayar" value={formatRupiah(summary.paid)} testId="payment-paid" />
          {summary.overpaid > 0 ? (
            <SummaryItem label="Lebih bayar" value={formatRupiah(summary.overpaid)} testId="payment-overpaid" />
          ) : (
            <SummaryItem label="Sisa" value={formatRupiah(summary.remaining)} testId="payment-remaining" />
          )}
        </dl>
        {summary.overpaid > 0 && (
          <p className="text-sm text-warning-700">
            Lebih bayar {formatRupiah(summary.overpaid)}: yang sudah dibayar melebihi tagihan pesanan ini. Pengembalian dana dari pemasok belum dicatat di sini.
          </p>
        )}
        {isCancelled && summary.overpaid === 0 && <p className="text-sm text-neutral-600">Pesanan dibatalkan, tidak ada tagihan.</p>}
      </Card>

      <h3 className="mt-4 mb-2 text-base font-semibold text-neutral-900">Riwayat pembayaran</h3>
      {payments.length === 0 ? (
        <p className="text-base text-neutral-600">Belum ada pembayaran.</p>
      ) : (
        <PaymentHistory payments={payments} canRecord={canRecord} />
      )}
    </section>
  );
}

function Struck({ voided, children }: { voided: boolean; children: ReactNode }) {
  return voided ? <span className="text-neutral-500 line-through">{children}</span> : <>{children}</>;
}

function PaymentHistory({ payments, canRecord }: { payments: PurchasePaymentRow[]; canRecord: boolean }) {
  const proofCell = (payment: PurchasePaymentRow) =>
    canRecord ? <PrivateFileLink file={payment.proof} label="Lihat bukti" title={`Bukti ${payment.paymentNo}`} /> : <span className="text-neutral-600">-</span>;
  const voidButton = (payment: PurchasePaymentRow) =>
    canRecord && payment.voidedAt === null ? <VoidRecordButton kind="payment" id={payment.id} label={payment.paymentNo} /> : null;

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
                  Kepada {payment.supplierName ?? "-"} · dicatat {formatDateTime(payment.createdAt)}
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
                <Td className="text-neutral-700">{payment.supplierName ?? "-"}</Td>
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

export function PurchaseInvoiceSection({
  purchaseId,
  attachments,
  canManage,
}: {
  purchaseId: string;
  attachments: PurchaseAttachmentRow[];
  /** inventory.manage (+ finance.view_profit): attach and void. Viewing needs inventory.view +
   * finance.view_profit, which rendering this section already implies. */
  canManage: boolean;
}) {
  return (
    <section aria-labelledby="invoices-heading" className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="invoices-heading" className="text-lg font-semibold text-neutral-900">
          Nota pemasok
        </h2>
        {canManage && <AttachInvoiceButton purchaseId={purchaseId} />}
      </div>
      {attachments.length === 0 ? (
        <p className="text-base text-neutral-600">Belum ada nota. Nota tidak wajib.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {attachments.map((attachment, index) => {
            const voided = attachment.voidedAt !== null;
            const label = `Nota ${index + 1}`;
            return (
              <li key={attachment.id} data-testid="invoice-row">
                <Card className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-base font-medium text-neutral-900">
                      <Struck voided={voided}>{attachment.file.originalFilename}</Struck>
                    </p>
                    {voided && <Badge variant="neutral">Dibatalkan</Badge>}
                  </div>
                  <p className="text-sm text-neutral-600">
                    Dilampirkan {formatDateTime(attachment.createdAt)}
                    {attachment.createdByName ? ` oleh ${attachment.createdByName}` : ""}
                  </p>
                  {attachment.note && <p className="text-sm text-neutral-800">{attachment.note}</p>}
                  {voided && <p className="text-sm text-neutral-700">{voidedLine(attachment)}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <PrivateFileLink file={attachment.file} label="Lihat nota" title={label} />
                    {canManage && !voided && <VoidRecordButton kind="attachment" id={attachment.id} label={label} />}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
