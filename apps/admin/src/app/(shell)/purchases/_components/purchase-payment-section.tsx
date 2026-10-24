import { Badge, Card } from "@ammari/ui";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { PaymentHistory, Struck, SummaryItem, voidedLine } from "@/components/supplier-payments/payment-history";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";
import { PrivateFileLink } from "@/components/supplier-payments/private-file-link";
import { RecordPaymentButton } from "@/components/supplier-payments/record-payment-button";
import { VoidRecordButton } from "@/components/supplier-payments/void-record-button";
import type { SupplierPaymentRow } from "@/lib/supplier-payments/payment-records";
import type { PurchaseAttachmentRow } from "@/lib/supplier-payments/purchase-payments";
import type { PaymentSummary } from "@/lib/supplier-payments/status";
import { recordPurchasePaymentAction, voidPurchaseAttachmentAction } from "../payment-actions";
import { AttachInvoiceButton } from "./attach-invoice-button";

// The purchase detail's "Pembayaran" and "Nota pemasok" sections (docs/plans/purchase-payments.md
// §9). Rendered only for finance.view_profit (the page decides; §7): every figure here is cost
// data. Recording, voiding and opening a proof additionally need supplier_payments.manage.

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
  payments: SupplierPaymentRow[];
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
        {canPay && (
          <RecordPaymentButton
            recordAction={recordPurchasePaymentAction}
            targetFields={{ purchaseId }}
            documentNo={purchaseNo}
            remaining={summary.remaining}
          />
        )}
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
      <PaymentHistory payments={payments} canRecord={canRecord} />
    </section>
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
                    {canManage && !voided && <VoidRecordButton kind="attachment" id={attachment.id} label={label} voidAction={voidPurchaseAttachmentAction} />}
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
