import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getSkuDetail, listStockLedger } from "@/lib/stock/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getDefectBalance, listItemDefectMovements, stripItemDefectAmounts } from "@/lib/defects/queries";
import { ItemDefectSection } from "../_components/item-defect-section";
import { StockLedger } from "../_components/stock-ledger";
import { StockStatusBadge } from "../_components/stock-list";
import { SkuDetailControls } from "../_components/sku-detail-controls";

export default async function SkuDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("stock.view");
  const { sku } = await params;
  const { page, perPage } = await searchParams;

  const detail = await getSkuDetail(sku);
  if (!detail) notFound();
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const [{ rows, pagination }, defectBalance, defectRows] = await Promise.all([
    listStockLedger(sku, page, perPage),
    getDefectBalance({ kind: "sku", sku: detail.sku }),
    listItemDefectMovements({ kind: "sku", sku: detail.sku }),
  ]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: detail.sku }]} />
      <PageHeader title={detail.sku} description={`${detail.productName} · ${detail.colorName} · ${detail.size === "ALLSIZE" ? "All Size" : detail.size}`} />
      <div className="mb-6 flex items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-neutral-900">{formatNumber(detail.currentStock)} pcs</span>
        <StockStatusBadge currentStock={detail.currentStock} minStockQty={detail.minStockQty} />
        {session.permissionKeys.includes("stock.adjust") && <SkuDetailControls sku={detail.sku} />}
      </div>
      <StockLedger sku={sku} rows={rows} pagination={pagination} searchParams={{ perPage }} />
      <ItemDefectSection
        kind="sku"
        balance={{ qty: defectBalance.qty, valueAmount: canViewProfit ? defectBalance.valueAmount : null }}
        rows={stripItemDefectAmounts(defectRows, canViewProfit)}
        canOpenPurchase={session.permissionKeys.includes("inventory.view")}
        canOpenBatch={session.permissionKeys.includes("production.manage")}
      />
    </>
  );
}
