import { Breadcrumb, Button, FilterTabs, Input, PageHeader } from "@ammari/ui";
import { sizeLabel } from "@ammari/commerce/size-label";
import { requirePermission } from "@/lib/auth/require-permission";
import { buildTsv } from "@/lib/csv";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { listSkus, SKU_LIST_MAX_ROWS, skuListFilters, skuListTable } from "@/lib/stock/sku-list";
import { SkuCopyButtons } from "./_components/sku-copy-buttons";
import { SkuList } from "./_components/sku-list";

// Daftar SKU (docs/plans/marketplace-import.md §11.1): the SKUs to put in Shopee/TikTok listings,
// since the order import matches by SKU only. Copy or download, never edit here.

const STATUS_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

export default async function SkuListPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requirePermission("stock.view");
  const { q, status } = await searchParams;
  const filters = skuListFilters({ q, status });
  const { rows, truncated } = await listSkus(filters);
  const table = skuListTable(rows, sizeLabel);

  const exportParams = new URLSearchParams();
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.activeFilter) exportParams.set("status", filters.activeFilter);
  const exportQuery = exportParams.toString();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/stock"), { label: "Daftar SKU" }]} />
      <PageHeader
        title="Daftar SKU"
        description="SKU setiap varian untuk diisi di kolom SKU variasi Shopee dan TikTok Shop. Impor pesanan mencocokkan barang hanya lewat SKU ini."
        actions={
          <a
            href={`/stock/sku-list/export${exportQuery ? `?${exportQuery}` : ""}`}
            download
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-neutral-500 bg-white px-4 text-base font-medium text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            Unduh CSV
          </a>
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs basePath="/stock/sku-list" paramName="status" options={STATUS_OPTIONS} activeValue={filters.activeFilter} aria-label="Filter status SKU" />
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3" method="GET">
          {filters.activeFilter && <input type="hidden" name="status" value={filters.activeFilter} />}
          <div className="flex-1">
            <Input name="q" defaultValue={filters.q ?? ""} placeholder="Cari produk, kode, warna atau SKU..." aria-label="Cari SKU" />
          </div>
          <Button type="submit">Cari</Button>
        </form>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-neutral-600" data-testid="sku-list-count">
            {rows.length.toLocaleString("id-ID")} SKU
          </p>
          {/* The copy text rides in the page payload (a few hundred SKUs in practice, capped at
              SKU_LIST_MAX_ROWS); fetching it on click is the fix if the catalogue ever grows. */}
          {rows.length > 0 && <SkuCopyButtons tableText={buildTsv(table)} skuText={rows.map((row) => row.sku).join("\n") + "\n"} />}
        </div>
        {truncated && (
          <p className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
            Hanya {SKU_LIST_MAX_ROWS.toLocaleString("id-ID")} SKU pertama yang ditampilkan. Persempit dengan pencarian atau filter.
          </p>
        )}
        <SkuList rows={rows} />
      </div>
    </>
  );
}
