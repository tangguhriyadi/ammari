import Link from "next/link";
import { Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";
import type { SupplierBalance, SupplierDocumentKind, SupplierPayableDocument } from "@/lib/supplier-payments/supplier-balance";

// The supplier detail's "Utang" card (docs/plans/purchase-payments.md §9, A3): every document
// that still bills this supplier, purchases and production batches alike, with what is left and
// the total. Rendered only for finance.view_profit (every figure is cost data); the page doesn't
// even run the query otherwise.

const KIND_LABELS: Record<SupplierDocumentKind, string> = {
  purchase: "Pembelian",
  production_batch: "Produksi",
};

function documentHref(document: SupplierPayableDocument): string {
  return document.kind === "purchase" ? `/purchases/${document.id}` : `/production/${document.id}`;
}

/** "Lebih bayar Rp X", else the remaining amount with `remainingLabel` in front ("Sisa " on a card;
 * nothing in the table, whose column is already called "Sisa"). */
function balanceText(document: SupplierPayableDocument, remainingLabel = ""): string {
  return document.payment.overpaid > 0
    ? `Lebih bayar ${formatRupiah(document.payment.overpaid)}`
    : `${remainingLabel}${formatRupiah(document.payment.remaining)}`;
}

export function SupplierPayables({ documents, balance }: { documents: SupplierPayableDocument[]; balance: SupplierBalance }) {
  return (
    <section aria-labelledby="supplier-payables-title" className="mb-6 flex flex-col gap-3">
      <h2 id="supplier-payables-title" className="text-lg font-semibold text-neutral-900">
        Utang ke supplier
      </h2>
      <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1" data-testid="supplier-payables-summary">
        <div>
          <p className="text-sm text-neutral-600">Total utang</p>
          <p className="text-xl font-semibold tabular-nums text-neutral-900" data-testid="supplier-outstanding">
            {formatRupiah(balance.outstanding)}
          </p>
        </div>
        {balance.overpaid > 0 && (
          <p className="text-base tabular-nums text-warning-700" data-testid="supplier-overpaid">
            Lebih bayar {formatRupiah(balance.overpaid)}
          </p>
        )}
      </Card>

      {documents.length === 0 ? (
        <p className="text-base text-neutral-600">Tidak ada tagihan yang belum lunas.</p>
      ) : (
        <>
          <CardList>
            {documents.map((document) => (
              <li key={`${document.kind}-${document.id}`} data-testid="payable-card">
                <Link href={documentHref(document)}>
                  <Card className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-medium text-neutral-900">{document.documentNo}</p>
                        <p className="text-sm text-neutral-600">
                          {KIND_LABELS[document.kind]} · {formatDate(new Date(document.documentDate))}
                        </p>
                      </div>
                      <PaymentStatusBadge status={document.payment.status} />
                    </div>
                    <p className="text-sm tabular-nums text-neutral-600">
                      Tagihan {formatRupiah(document.payment.tagihan)} · Dibayar {formatRupiah(document.payment.paid)}
                    </p>
                    <p className="text-base font-medium tabular-nums text-neutral-900">
                      {balanceText(document, "Sisa ")}
                    </p>
                  </Card>
                </Link>
              </li>
            ))}
          </CardList>

          <TableContainer>
            <TableHead>
              <Th>Dokumen</Th>
              <Th>Jenis</Th>
              <Th>Tanggal</Th>
              <Th className="text-right">Tagihan</Th>
              <Th className="text-right">Dibayar</Th>
              <Th className="text-right">Sisa</Th>
              <Th>Pembayaran</Th>
            </TableHead>
            <tbody>
              {documents.map((document) => (
                <Tr key={`${document.kind}-${document.id}`} data-testid="payable-row">
                  <Td>
                    <Link href={documentHref(document)} className="font-medium text-brand hover:underline">
                      {document.documentNo}
                    </Link>
                  </Td>
                  <Td className="text-neutral-700">{KIND_LABELS[document.kind]}</Td>
                  <Td className="text-neutral-700">{formatDate(new Date(document.documentDate))}</Td>
                  <Td className="text-right tabular-nums">{formatRupiah(document.payment.tagihan)}</Td>
                  <Td className="text-right tabular-nums">{formatRupiah(document.payment.paid)}</Td>
                  <Td className="text-right tabular-nums">{balanceText(document)}</Td>
                  <Td>
                    <PaymentStatusBadge status={document.payment.status} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </section>
  );
}
