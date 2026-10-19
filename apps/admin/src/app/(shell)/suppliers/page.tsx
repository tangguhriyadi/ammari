import Link from "next/link";
import { PageHeader, Button, Input, FilterTabs, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listSuppliers, type SupplierActiveFilter } from "@/lib/suppliers/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SupplierList } from "./_components/supplier-list";

const ACTIVE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, page, perPage } = await searchParams;
  const activeFilter: SupplierActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const canManage = session.permissionKeys.includes("inventory.manage");

  const { rows, pagination } = await listSuppliers({ q, activeFilter }, page, perPage);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/suppliers")} />
      <PageHeader
        title="Pemasok"
        description="Daftar pemasok kain, aksesoris, dan penjahit beserta kontak dan rekeningnya."
        actions={
          canManage ? (
            <Link href="/suppliers/new">
              <Button>Tambah pemasok</Button>
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/suppliers"
          paramName="status"
          options={ACTIVE_FILTER_OPTIONS}
          activeValue={activeFilter}
          aria-label="Filter status pemasok"
        />
        <form method="GET">
          {rawStatus && <input type="hidden" name="status" value={rawStatus} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama pemasok..." aria-label="Cari pemasok" />
        </form>
        <SupplierList
          // Projected explicitly, not spread: the list needs four fields, and address/bank
          // details have no business being serialized into the RSC payload for a page that
          // never renders them.
          rows={rows.map((row) => ({ id: row.id, name: row.name, kinds: row.kinds, phone: row.phone, isActive: row.isActive }))}
          canManage={canManage}
        />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/suppliers"
        searchParams={{ q, status: rawStatus, perPage }}
        itemLabel="pemasok"
      />
    </>
  );
}
