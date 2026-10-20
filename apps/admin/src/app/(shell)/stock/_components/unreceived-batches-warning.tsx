import Link from "next/link";
import { formatDate } from "@ammari/ui/lib";
import { PRODUCTION_RECEIPT_STATUS_LABELS } from "@/lib/production/receipt-status";
import type { UnreceivedBatchForProduct } from "@/lib/receipts/production";

/** The stock-count guard (docs/plans/suppliers-goods-receipt.md §6, S4). Finished goods that are
 * physically in the house but not yet received read as missing; "correcting" them with a count
 * would turn them into an adjustment, detached from their batch and its HPP for good. So the page
 * lists that product's posted-but-not-fully-received batches, with a link when the session can
 * open them (production.manage). */
export function UnreceivedBatchesWarning({ batches, canOpenBatches }: { batches: UnreceivedBatchForProduct[]; canOpenBatches: boolean }) {
  if (batches.length === 0) return null;
  return (
    <div role="note" aria-labelledby="unreceived-batches-title" className="rounded-lg border border-warning-200 bg-warning-50 p-4">
      <p id="unreceived-batches-title" className="text-base font-semibold text-warning-700">
        Ada hasil produksi yang belum diterima
      </p>
      <p className="mt-1 text-base text-neutral-800">
        Barang dari batch berikut mungkin sudah ada di rumah tapi belum masuk stok. Terima dulu hasilnya di halaman batch, jangan
        dimasukkan lewat hitung stok.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-base text-neutral-800">
        {batches.map((batch) => (
          <li key={batch.id} data-testid="unreceived-batch">
            {canOpenBatches ? (
              <Link href={`/production/${batch.id}`} className="font-mono font-medium text-brand hover:underline">
                {batch.batchNo}
              </Link>
            ) : (
              <span className="font-mono font-medium">{batch.batchNo}</span>
            )}
            <span className="text-neutral-700">
              {" "}
              · {formatDate(new Date(batch.producedAt))} · {PRODUCTION_RECEIPT_STATUS_LABELS[batch.receiptStatus]} · sisa {batch.outstandingPcs} pcs
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
