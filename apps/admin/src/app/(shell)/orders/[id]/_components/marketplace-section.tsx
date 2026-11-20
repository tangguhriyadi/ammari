import Link from "next/link";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { MarketplaceOrderDetail } from "@/lib/orders/queries";
import { FEE_COMPONENT_LABELS } from "@/lib/marketplace-import/preview-view";
import { DetailList, DetailRow, SectionCard, SubSection } from "./section-card";

// The "Marketplace" block of an imported (or import-matched) order (docs/plans/marketplace-import.md
// §11): the raw marketplace status, when an import last confirmed it, and (finance only) the platform
// fees from the export.

export function MarketplaceSection({ marketplace, canViewProfit, canViewImports, className }: { marketplace: MarketplaceOrderDetail; canViewProfit: boolean; canViewImports: boolean; className?: string }) {
  const fees = canViewProfit ? marketplace.fees : null;
  return (
    <SectionCard title="Marketplace" testId="marketplace-section" className={className}>
      <DetailList>
        <DetailRow label="Status di marketplace" value={marketplace.channelStatus ?? "-"} />
        <DetailRow label="Terakhir diperbarui dari impor" value={marketplace.syncedAt ? formatDateTime(marketplace.syncedAt) : "-"} />
      </DetailList>
      {/* The batch page needs orders.import. */}
      {marketplace.importBatchId && canViewImports && (
        <Link href={`/import/${marketplace.importBatchId}`} className="inline-flex min-h-11 items-center self-start text-sm text-neutral-900 underline underline-offset-4">
          Lihat impor yang membuat pesanan ini
        </Link>
      )}
      {fees && (
        <SubSection title="Biaya platform">
          {fees.length === 0 ? (
            <span className="text-sm text-neutral-600">Belum ada data biaya dari file impor.</span>
          ) : (
            <DetailList>
              {fees.map((fee) => (
                <DetailRow key={fee.component} label={FEE_COMPONENT_LABELS[fee.component]} value={<span className="tabular-nums">{formatRupiah(fee.amount)}</span>} />
              ))}
            </DetailList>
          )}
        </SubSection>
      )}
    </SectionCard>
  );
}
