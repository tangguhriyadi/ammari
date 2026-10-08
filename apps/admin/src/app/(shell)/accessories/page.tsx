import Link from "next/link";
import { PageHeader, Button, Input, FilterTabs, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAccessories, type AccessoryActiveFilter } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccessoryList } from "./_components/accessory-list";

const ACTIVE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

export default async function AccessoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, page, perPage } = await searchParams;
  const activeFilter: AccessoryActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const { rows, pagination } = await listAccessories({ q, activeFilter }, page, perPage);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accessories")} />
      <PageHeader
        title="Aksesoris"
        description="Stok aksesoris (kancing, label, hang tag, dll) dan riwayat pembeliannya."
        actions={
          canManage ? (
            <Link href="/accessories/new">
              <Button>Tambah aksesoris</Button>
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/accessories"
          paramName="status"
          options={ACTIVE_FILTER_OPTIONS}
          activeValue={activeFilter}
          aria-label="Filter status aksesoris"
        />
        <form method="GET">
          {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama aksesoris..." aria-label="Cari aksesoris" />
        </form>
        <AccessoryList
          // Stripped server-side, not just hidden in the UI, for a session without
          // finance.view_profit — same discipline Phase C's createDraftAction applies.
          rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))}
          canViewProfit={canViewProfit}
          canManage={canManage}
        />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/accessories"
        searchParams={{ q, status: rawStatus, perPage }}
        itemLabel="aksesoris"
      />
    </>
  );
}
