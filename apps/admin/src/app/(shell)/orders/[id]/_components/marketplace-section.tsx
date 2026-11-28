import Link from "next/link";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { Badge } from "@ammari/ui";
import { ReceiveReturnButton } from "@/components/orders/receive-return-button";
import { TikTokPackingBadge } from "@/components/orders/tiktok-packing-badge";
import { formatResponseDeadline, tiktokNeedsPersonLabel, tiktokRequestKindLabel, tiktokRequestStatusLabel } from "@/lib/orders/tiktok-return-labels";
import type { MarketplaceOrderDetail } from "@/lib/orders/queries";
import { FEE_COMPONENT_LABELS } from "@/lib/marketplace-import/preview-view";
import { DetailList, DetailRow, SectionCard, SubSection } from "./section-card";

// The "Marketplace" block of an imported (or import-matched) order (docs/plans/marketplace-import.md
// §11): the raw marketplace status, when an import last confirmed it, and (finance only) the platform
// fees from the export. A TikTok order applied by the sync (docs/plans/tiktok-shop-integration.md T5)
// also shows its packing gate, ship-by time, buyer message and TikTok's own dates.

export function MarketplaceSection({
  marketplace,
  canViewProfit,
  canViewImports,
  className,
  receiveReturn,
}: {
  marketplace: MarketplaceOrderDetail;
  canViewProfit: boolean;
  canViewImports: boolean;
  className?: string;
  /** Set when the parcel is on its way back and the viewer holds orders.manage (T6, "Retur diterima"). */
  receiveReturn?: { orderId: string; orderNo: string } | null;
}) {
  const fees = canViewProfit ? marketplace.fees : null;
  const requests = marketplace.tiktok?.requests ?? [];
  const now = new Date();
  return (
    <SectionCard title="Marketplace" testId="marketplace-section" className={className}>
      <DetailList>
        <DetailRow label="Status di marketplace" value={marketplace.channelStatus ?? "-"} />
        <DetailRow label={marketplace.tiktok ? "Terakhir diperbarui dari TikTok Shop" : "Terakhir diperbarui dari impor"} value={marketplace.syncedAt ? formatDateTime(marketplace.syncedAt) : "-"} />
        {marketplace.tiktok && <DetailRow label="Packing" value={<TikTokPackingBadge packing={marketplace.tiktok.packing} />} />}
        {marketplace.tiktok?.rtsSlaTime && <DetailRow label="Kirim paling lambat" value={formatDateTime(marketplace.tiktok.rtsSlaTime)} />}
        {marketplace.marketplaceShippedAt && <DetailRow label="Diserahkan ke kurir (marketplace)" value={formatDateTime(marketplace.marketplaceShippedAt)} />}
        {marketplace.marketplaceCompletedAt && <DetailRow label="Selesai (marketplace)" value={formatDateTime(marketplace.marketplaceCompletedAt)} />}
        {marketplace.marketplaceReturnedAt && <DetailRow label="Dibatalkan atau diretur (marketplace)" value={formatDateTime(marketplace.marketplaceReturnedAt)} />}
      </DetailList>
      {marketplace.tiktok?.buyerMessage && (
        <SubSection title="Pesan pembeli">
          <p className="whitespace-pre-line break-words text-base text-neutral-900" data-testid="tiktok-buyer-message">
            {marketplace.tiktok.buyerMessage}
          </p>
        </SubSection>
      )}
      {requests.length > 0 && (
        <SubSection title="Retur dan pembatalan TikTok">
          <ul className="flex flex-col gap-2" data-testid="tiktok-order-requests">
            {requests.map((request) => (
              <li key={`${request.kind}:${request.requestId}`} className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3">
                <span className="flex flex-wrap items-center gap-2 text-base font-medium text-neutral-900">
                  {tiktokRequestKindLabel(request.kind, request.requestType)}
                  {(request.state === "review" || request.state === "partial") && <Badge variant="danger">{tiktokNeedsPersonLabel(request.state, request.reviewReason)}</Badge>}
                </span>
                <span className="text-sm text-neutral-700">{tiktokRequestStatusLabel(request.status)}</span>
                {request.responseDueAt && request.responseDueAt.getTime() > now.getTime() && (
                  <span className="text-sm text-danger-700">Jawab di Seller Center sebelum {formatResponseDeadline(request.responseDueAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </SubSection>
      )}
      {receiveReturn && (
        <SubSection title="Paket sedang kembali">
          <p className="text-sm text-neutral-700">Stok belum dikembalikan. Tekan Retur diterima setelah paketnya sampai di toko.</p>
          <ReceiveReturnButton orderId={receiveReturn.orderId} orderNo={receiveReturn.orderNo} />
        </SubSection>
      )}
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
