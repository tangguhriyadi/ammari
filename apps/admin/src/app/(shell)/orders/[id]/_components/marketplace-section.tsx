import Link from "next/link";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { MarketplaceOrderDetail } from "@/lib/orders/queries";
import { FEE_COMPONENT_LABELS } from "@/lib/marketplace-import/preview-view";

// The "Marketplace" block of an imported (or import-matched) order (docs/plans/marketplace-import.md
// §11): the raw marketplace status, when an import last confirmed it, and (finance only) the platform
// fees from the export.

export function MarketplaceSection({ marketplace, canViewProfit, canViewImports }: { marketplace: MarketplaceOrderDetail; canViewProfit: boolean; canViewImports: boolean }) {
  const fees = canViewProfit ? marketplace.fees : null;
  return (
    <section aria-labelledby="marketplace-heading" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4" data-testid="marketplace-section">
      <h2 id="marketplace-heading" className="text-lg font-semibold text-neutral-900">
        Marketplace
      </h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-600">Status di marketplace</span>
        <span className="text-base text-neutral-900">{marketplace.channelStatus ?? "-"}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-600">Terakhir diperbarui dari impor</span>
        <span className="text-base text-neutral-900">{marketplace.syncedAt ? formatDateTime(marketplace.syncedAt) : "-"}</span>
      </div>
      {/* The batch page needs orders.import. */}
      {marketplace.importBatchId && canViewImports && (
        <Link href={`/import/${marketplace.importBatchId}`} className="inline-flex min-h-11 items-center self-start text-sm text-neutral-900 underline underline-offset-4">
          Lihat impor yang membuat pesanan ini
        </Link>
      )}
      {fees && (
        <div className="flex flex-col gap-1 border-t border-neutral-200 pt-2">
          <span className="text-sm font-medium text-neutral-900">Biaya platform</span>
          {fees.length === 0 ? (
            <span className="text-sm text-neutral-600">Belum ada data biaya dari file impor.</span>
          ) : (
            fees.map((fee) => (
              <div key={fee.component} className="flex items-center justify-between gap-3">
                <span className="text-sm text-neutral-600">{FEE_COMPONENT_LABELS[fee.component]}</span>
                <span className="text-base tabular-nums text-neutral-900">{formatRupiah(fee.amount)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
