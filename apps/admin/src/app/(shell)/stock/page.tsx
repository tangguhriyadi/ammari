import { PageHeader, FilterTabs, Input, Checkbox, Button } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listStockOverview, type ActiveFilter } from "@/lib/stock/queries";
import { StockList } from "./_components/stock-list";
import { StockTypeTabs } from "./_components/stock-type-tabs";

const ACTIVE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; low?: string; page?: string }>;
}) {
  const session = await requirePermission("stock.view");
  const { q, status: rawStatus, low, page } = await searchParams;
  const activeFilter: ActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const lowStockOnly = low === "1";

  const { rows, pagination } = await listStockOverview({ q, activeFilter, lowStockOnly }, page);

  return (
    <>
      <PageHeader title="Stok" description="Stok per SKU dan riwayat pergerakannya." />
      <StockTypeTabs
        active="Barang jadi"
        canViewFinishedGoods
        canViewRawMaterials={session.permissionKeys.includes("inventory.view")}
      />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3" method="GET">
        {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
        <div className="flex-1">
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama produk atau SKU..." aria-label="Cari stok" />
        </div>
        <Checkbox name="low" value="1" defaultChecked={lowStockOnly} label="Stok menipis saja" />
        <Button type="submit">Filter</Button>
      </form>
      <FilterTabs
        basePath="/stock"
        paramName="status"
        options={ACTIVE_FILTER_OPTIONS}
        activeValue={activeFilter}
        aria-label="Filter status varian"
      />
      <StockList
        rows={rows}
        pagination={pagination}
        searchParams={{ q, status: rawStatus, low }}
        canAdjust={session.permissionKeys.includes("stock.adjust")}
      />
    </>
  );
}
