import { PageHeader, Input, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithBalance } from "@/lib/inventory/fabric-stock";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { FabricStockList } from "../_components/fabric-stock-list";

export default async function FabricStockPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await requirePermission("inventory.view");
  const { q, page } = await searchParams;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listFabricsWithBalance({ q }, page);

  return (
    <>
      <PageHeader title="Stok bahan" description="Stok dan riwayat pergerakan bahan (kain)." />
      <StockTypeTabs
        active="Kain"
        canViewFinishedGoods={session.permissionKeys.includes("stock.view")}
        canViewRawMaterials
      />
      <form className="mb-4" method="GET">
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan..." aria-label="Cari bahan" />
      </form>
      <FabricStockList rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))} />
      <Pagination pagination={pagination} basePath="/stock/fabrics" searchParams={{ q }} itemLabel="bahan" />
    </>
  );
}
