import { PageHeader, Input, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithBalance } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StockTypeTabs } from "../_components/stock-type-tabs";
import { FabricStockList } from "../_components/fabric-stock-list";

export default async function FabricStockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, page, perPage } = await searchParams;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listFabricsWithBalance({ q }, page, perPage);

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
        <FabricStockList rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))} />
      </div>
      <Pagination pagination={pagination} basePath="/stock/fabrics" searchParams={{ q, perPage }} itemLabel="bahan" />
    </>
  );
}
