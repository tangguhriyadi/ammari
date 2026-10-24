import { Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { PaymentHistory, SummaryItem } from "@/components/supplier-payments/payment-history";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";
import { RecordPaymentButton } from "@/components/supplier-payments/record-payment-button";
import { payeeKey, type BatchPaymentSummary } from "@/lib/supplier-payments/batch-payments";
import type { SupplierPaymentRow } from "@/lib/supplier-payments/payment-records";
import { recordBatchPaymentAction } from "../payment-actions";

// The posted batch's "Pembayaran" section (docs/plans/purchase-payments.md §9, session S4): what
// is due is the service lines only (ongkos jahit, finishing...), never fabric or accessories (A2),
// and it is tracked per payee (P12). Rendered only for finance.view_profit (the page decides; §7):
// every figure is cost data. Recording, voiding and opening a proof also need
// supplier_payments.manage.

const NO_SUPPLIER_LABEL = "Tanpa pemasok";

export function BatchPaymentSection({
  batchId,
  batchNo,
  summary,
  payments,
  canRecord,
}: {
  batchId: string;
  batchNo: string;
  summary: BatchPaymentSummary;
  payments: SupplierPaymentRow[];
  canRecord: boolean;
}) {
  const payable = summary.payees
    .filter((payee) => payee.remaining > 0)
    .map((payee) => ({ key: payeeKey(payee.supplierId), name: payee.supplierName ?? NO_SUPPLIER_LABEL, remaining: payee.remaining }));
  const { overall } = summary;

  return (
    <section aria-labelledby="payments-heading" className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="payments-heading" className="text-lg font-semibold text-neutral-900">
          Pembayaran
        </h2>
        {canRecord && payable.length > 0 && (
          <RecordPaymentButton recordAction={recordBatchPaymentAction} targetFields={{ productionBatchId: batchId }} documentNo={batchNo} payees={payable} />
        )}
      </div>

      <Card className="flex flex-col gap-3" data-testid="payment-summary">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-neutral-600">Status pembayaran batch</span>
          <PaymentStatusBadge status={overall.status} />
        </div>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <SummaryItem label="Tagihan" value={formatRupiah(overall.tagihan)} testId="payment-tagihan" />
          <SummaryItem label="Dibayar" value={formatRupiah(overall.paid)} testId="payment-paid" />
          <SummaryItem label="Sisa" value={formatRupiah(overall.remaining)} testId="payment-remaining" />
        </dl>
        <p className="text-sm text-neutral-600">
          Tagihan hanya biaya jasa (ongkos jahit, finishing, dan lainnya), tanpa bahan dan aksesoris yang sudah dibayar lewat pembelian.
        </p>
      </Card>

      {summary.payees.length === 0 ? (
        <p className="mt-3 text-base text-neutral-600">Batch ini tidak punya biaya jasa, jadi tidak ada yang perlu dibayar.</p>
      ) : (
        <>
          <h3 className="mt-4 mb-2 text-base font-semibold text-neutral-900">Per penerima</h3>
          <CardList>
            {summary.payees.map((payee) => (
              <li key={payeeKey(payee.supplierId)} data-testid="payee-card">
                <Card className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-base font-medium text-neutral-900">{payee.supplierName ?? NO_SUPPLIER_LABEL}</span>
                    <PaymentStatusBadge status={payee.status} />
                  </div>
                  <dl className="grid grid-cols-3 gap-2">
                    <SummaryItem label="Tagihan" value={formatRupiah(payee.tagihan)} />
                    <SummaryItem label="Dibayar" value={formatRupiah(payee.paid)} />
                    <SummaryItem label="Sisa" value={formatRupiah(payee.remaining)} />
                  </dl>
                </Card>
              </li>
            ))}
          </CardList>
          <TableContainer>
            <TableHead>
              <Th>Penerima</Th>
              <Th>Tagihan</Th>
              <Th>Dibayar</Th>
              <Th>Sisa</Th>
              <Th>Status</Th>
            </TableHead>
            <tbody>
              {summary.payees.map((payee) => (
                <Tr key={payeeKey(payee.supplierId)} data-testid="payee-row">
                  <Td className="font-medium text-neutral-900">{payee.supplierName ?? NO_SUPPLIER_LABEL}</Td>
                  <Td className="tabular-nums text-neutral-700">{formatRupiah(payee.tagihan)}</Td>
                  <Td className="tabular-nums text-neutral-700">{formatRupiah(payee.paid)}</Td>
                  <Td className="tabular-nums text-neutral-900">{formatRupiah(payee.remaining)}</Td>
                  <Td>
                    <PaymentStatusBadge status={payee.status} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}

      <h3 className="mt-4 mb-2 text-base font-semibold text-neutral-900">Riwayat pembayaran</h3>
      <PaymentHistory payments={payments} canRecord={canRecord} />
    </section>
  );
}

/** A draft has no tagihan yet (§3.2), so no payment can be recorded; says why. Finance only. */
export function DraftPaymentNotice() {
  return (
    <section aria-labelledby="payments-heading" className="mt-6">
      <h2 id="payments-heading" className="mb-2 text-lg font-semibold text-neutral-900">
        Pembayaran
      </h2>
      <p className="text-base text-neutral-600" data-testid="draft-payment-notice">
        Batch ini masih draf, jadi belum ada tagihan. Pembayaran ke penjahit atau penyedia jasa bisa dicatat setelah batch diposting, karena biaya jasa masih bisa berubah selama draf.
      </p>
    </section>
  );
}
