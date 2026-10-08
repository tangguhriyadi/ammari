import { notFound } from "next/navigation";
import { PageHeader } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getSkuDetail, listStockLedger } from "@/lib/stock/queries";
import { StockLedger } from "../_components/stock-ledger";
import { StockStatusBadge } from "../_components/stock-list";
import { SkuDetailControls } from "../_components/sku-detail-controls";

export default async function SkuDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await requirePermission("stock.view");
  const { sku } = await params;
  const { page } = await searchParams;

  const detail = await getSkuDetail(sku);
  if (!detail) notFound();
  const { rows, pagination } = await listStockLedger(sku, page);

  return (
    <>
      <PageHeader title={detail.sku} description={`${detail.productName} · ${detail.colorName} · ${detail.size === "ALLSIZE" ? "All Size" : detail.size}`} />
      <div className="mb-6 flex items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-neutral-900">{formatNumber(detail.currentStock)} pcs</span>
        <StockStatusBadge currentStock={detail.currentStock} minStockQty={detail.minStockQty} />
        {session.permissionKeys.includes("stock.adjust") && <SkuDetailControls sku={detail.sku} />}
      </div>
      <StockLedger sku={sku} rows={rows} pagination={pagination} />
    </>
  );
}
