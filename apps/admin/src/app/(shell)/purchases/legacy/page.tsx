import { PageHeader, Input, FilterTabs, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listPurchases, stripPurchaseAmounts, type PurchaseTypeFilter } from "@/lib/inventory/purchases";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { LegacyPurchaseList } from "../_components/legacy-purchase-list";

const TYPE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Kain", value: "fabric" },
  { label: "Aksesoris", value: "accessory" },
] as const;

/** Single-row purchases recorded before purchase documents existed
 * (docs/plans/suppliers-goods-receipt.md D11). Read-only history; their stock was added when they
 * were recorded and stays. Rows written by a goods receipt never appear here. */
export default async function LegacyPurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, type: rawType, page, perPage } = await searchParams;
  const typeFilter: PurchaseTypeFilter = rawType === "fabric" || rawType === "accessory" ? rawType : undefined;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  const { rows, pagination } = await listPurchases({ type: typeFilter, q }, page, perPage);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: "Pembelian lama" }]} />
      <PageHeader title="Pembelian lama" description="Pembelian yang dicatat sebelum ada pesanan pembelian. Stoknya sudah masuk saat dicatat." />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/purchases/legacy"
          paramName="type"
          options={TYPE_FILTER_OPTIONS}
          activeValue={typeFilter}
          aria-label="Filter jenis pembelian"
        />
        <form method="GET">
          {rawType && <input type="hidden" name="type" value={rawType} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan atau aksesoris..." aria-label="Cari pembelian lama" />
        </form>
        <LegacyPurchaseList rows={stripPurchaseAmounts(rows, canViewProfit)} />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/purchases/legacy"
        searchParams={{ q, type: rawType, perPage }}
        itemLabel="pembelian"
      />
    </>
  );
}
