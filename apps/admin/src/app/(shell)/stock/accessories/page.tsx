import { PageHeader, Input, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAccessories } from "@/lib/inventory/accessories";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { AccessoryStockList } from "../_components/accessory-stock-list";

export default async function AccessoryStockPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await requirePermission("inventory.view");
  const { q, page } = await searchParams;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listAccessories({ q }, page);

  return (
    <>
      <PageHeader title="Stok aksesoris" description="Stok dan riwayat pergerakan aksesoris." />
      <StockTypeTabs
        active="Aksesoris"
        canViewFinishedGoods={session.permissionKeys.includes("stock.view")}
        canViewRawMaterials
      />
      <form className="mb-4" method="GET">
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama aksesoris..." aria-label="Cari aksesoris" />
      </form>
      <AccessoryStockList
        rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))}
      />
      <Pagination pagination={pagination} basePath="/stock/accessories" searchParams={{ q }} itemLabel="aksesoris" />
    </>
  );
}
