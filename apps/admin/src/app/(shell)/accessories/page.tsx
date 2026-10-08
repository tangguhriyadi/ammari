import Link from "next/link";
import { PageHeader, Button, Input, FilterTabs, Pagination } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAccessories, type AccessoryActiveFilter } from "@/lib/inventory/accessories";
import { AccessoryList } from "./_components/accessory-list";

const ACTIVE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

export default async function AccessoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, page } = await searchParams;
  const activeFilter: AccessoryActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const { rows, pagination } = await listAccessories({ q, activeFilter }, page);

  return (
    <>
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
      <form className="mb-4" method="GET">
        {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
        <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama aksesoris..." aria-label="Cari aksesoris" />
      </form>
      <FilterTabs
        basePath="/accessories"
        paramName="status"
        options={ACTIVE_FILTER_OPTIONS}
        activeValue={activeFilter}
        aria-label="Filter status aksesoris"
      />
      <AccessoryList
        // Stripped server-side, not just hidden in the UI, for a session without
        // finance.view_profit — same discipline Phase C's createDraftAction applies.
        rows={rows.map((row) => ({ ...row, valueAmount: canViewProfit ? row.valueAmount : null }))}
        canViewProfit={canViewProfit}
        canManage={canManage}
      />
      <Pagination pagination={pagination} basePath="/accessories" searchParams={{ q, status: rawStatus }} itemLabel="aksesoris" />
    </>
  );
}
