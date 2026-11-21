import { PageHeader, Input, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricColorBalancesByFabric, listFabricsWithBalance } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getDefectQtyByFabric } from "@/lib/defects/queries";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { FabricStockList } from "../_components/fabric-stock-list";
import { toFabricColorStock } from "../_components/fabric-color-stock";

export default async function FabricStockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, page, perPage } = await searchParams;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listFabricsWithBalance({ q }, page, perPage);
  const fabricIds = rows.map((row) => row.id);
  const [defectQty, colorBalances] = await Promise.all([getDefectQtyByFabric(fabricIds), listFabricColorBalancesByFabric(fabricIds)]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Kain" }]} />
      <PageHeader title="Stok bahan" description="Stok dan riwayat pergerakan bahan (kain)." />
      <div className="flex flex-col gap-3">
        <StockTypeTabs
          active="Kain"
          canViewFinishedGoods={session.permissionKeys.includes("stock.view")}
          canViewRawMaterials
        />
        <form method="GET">
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan..." aria-label="Cari bahan" />
        </form>
        <FabricStockList
          rows={rows.map((row) => ({
            ...row,
            defectQty: defectQty.get(row.id) ?? 0,
            valueAmount: canViewProfit ? row.valueAmount : null,
            colors: toFabricColorStock(colorBalances.get(row.id) ?? [], canViewProfit),
          }))}
        />
      </div>
      <Pagination pagination={pagination} basePath="/stock/fabrics" searchParams={{ q, perPage }} itemLabel="bahan" />
    </>
  );
}
