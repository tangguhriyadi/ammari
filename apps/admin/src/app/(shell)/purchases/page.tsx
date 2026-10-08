import Link from "next/link";
import { PageHeader, Button, Input, FilterTabs, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listPurchases, stripPurchaseAmounts, type PurchaseTypeFilter } from "@/lib/inventory/purchases";
import { PurchaseList } from "./_components/purchase-list";

const TYPE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Kain", value: "fabric" },
  { label: "Aksesoris", value: "accessory" },
] as const;

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, type: rawType, page } = await searchParams;
  const typeFilter: PurchaseTypeFilter = rawType === "fabric" || rawType === "accessory" ? rawType : undefined;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const { rows, pagination } = await listPurchases({ type: typeFilter, q }, page);

  return (
    <>
      <PageHeader
        title="Pembelian"
        description="Riwayat pembelian bahan dan aksesoris."
        actions={
          canManage ? (
            <Link href="/purchases/new">
              <Button>Catat pembelian</Button>
            </Link>
          ) : undefined
        }
      />
      <form className="mb-4" method="GET">
        {rawType && <input type="hidden" name="type" value={rawType} />}
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama bahan atau aksesoris..." aria-label="Cari pembelian" />
      </form>
      <FilterTabs basePath="/purchases" paramName="type" options={TYPE_FILTER_OPTIONS} activeValue={typeFilter} aria-label="Filter jenis pembelian" />
      <PurchaseList rows={stripPurchaseAmounts(rows, canViewProfit)} />
      <Pagination pagination={pagination} basePath="/purchases" searchParams={{ q, type: rawType }} itemLabel="pembelian" />
    </>
  );
}
