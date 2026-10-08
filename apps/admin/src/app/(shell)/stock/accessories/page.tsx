import { PageHeader, Input, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAccessories } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { AccessoryStockList } from "../_components/accessory-stock-list";

export default async function AccessoryStockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, page, perPage } = await searchParams;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listAccessories({ q }, page, perPage);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Aksesoris" }]} />
      <PageHeader title="Stok aksesoris" description="Stok dan riwayat pergerakan aksesoris." />
      <div className="flex flex-col gap-3">
        <StockTypeTabs
          active="Aksesoris"
          canViewFinishedGoods={session.permissionKeys.includes("stock.view")}
          canViewRawMaterials
        />
        <form method="GET">
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama aksesoris..." aria-label="Cari aksesoris" />
        </form>
        <AccessoryStockList rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))} />
      </div>
      <Pagination pagination={pagination} basePath="/stock/accessories" searchParams={{ q, perPage }} itemLabel="aksesoris" />
    </>
  );
}
