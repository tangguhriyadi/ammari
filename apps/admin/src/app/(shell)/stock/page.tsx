import Link from "next/link";
import { PageHeader, FilterTabs, Input, Checkbox, Button, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getReservedQtyBySku, listStockOverview, type ActiveFilter } from "@/lib/stock/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getDefectQtyBySku } from "@/lib/defects/queries";
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
  searchParams: Promise<{ q?: string; status?: string; low?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("stock.view");
  const { q, status: rawStatus, low, page, perPage } = await searchParams;
  const activeFilter: ActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const lowStockOnly = low === "1";

  const { rows, pagination } = await listStockOverview({ q, activeFilter, lowStockOnly }, page, perPage);
  const pageSkus = rows.map((row) => row.sku);
  // S5b: defect stock per SKU, its own figure, never part of the sellable count. "Dipesan"
  // (docs/plans/cart-checkout.md §7): pieces held for unpaid web orders, still part of the count.
  const [defectQtyBySku, reservedQtyBySku] = await Promise.all([getDefectQtyBySku(pageSkus), getReservedQtyBySku(pageSkus)]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Barang jadi" }]} />
      <PageHeader
        title="Stok"
        description="Stok per SKU dan riwayat pergerakannya."
        actions={
          <Link href="/stock/sku-list">
            <Button variant="secondary">Daftar SKU</Button>
          </Link>
        }
      />
      <div className="flex flex-col gap-3">
        <StockTypeTabs
          active="Barang jadi"
          canViewFinishedGoods
          canViewRawMaterials={session.permissionKeys.includes("inventory.view")}
        />
        <FilterTabs
          basePath="/stock"
          paramName="status"
          options={ACTIVE_FILTER_OPTIONS}
          activeValue={activeFilter}
          aria-label="Filter status varian"
        />
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3" method="GET">
          {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
          <div className="flex-1">
            <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama produk atau SKU..." aria-label="Cari stok" />
          </div>
          <Checkbox name="low" value="1" defaultChecked={lowStockOnly} label="Stok menipis saja" />
          <Button type="submit">Filter</Button>
        </form>
        <StockList
          rows={rows}
          canAdjust={session.permissionKeys.includes("stock.adjust")}
          defectQtyBySku={defectQtyBySku}
          reservedQtyBySku={reservedQtyBySku}
        />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/stock"
        searchParams={{ q, status: rawStatus, low, perPage }}
        itemLabel="SKU"
      />
    </>
  );
}
