import Link from "next/link";
import { PageHeader, Button, Input, Tabs, Pagination, Breadcrumb, EmptyState } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listSuppliers, type SupplierActiveFilter } from "@/lib/suppliers/queries";
import { getSupplierBalances } from "@/lib/supplier-payments/supplier-balance";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SupplierList } from "./_components/supplier-list";

const ACTIVE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

// docs/plans/purchase-payments.md §9: "Total utang" per supplier. The tab and the column exist
// only for a viewer with finance.view_profit (who is owed money is cost data).
const BALANCE_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Ada utang", value: "owed" },
] as const;

/** The two filter rows combine, so each tab keeps the other row's choice and the search (FilterTabs
 * builds a single-param link, which would drop them). Paging restarts at 1. */
function listHref(params: { status?: string; balance?: string; q?: string }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `/suppliers?${query}` : "/suppliers";
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; balance?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, balance: rawBalance, page, perPage } = await searchParams;
  const activeFilter: SupplierActiveFilter = rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined;
  const canManage = session.permissionKeys.includes("inventory.manage");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  // Ignored without finance.view_profit: the filtered list itself would say who is owed money.
  const balanceFilter = canViewProfit && rawBalance === "owed" ? "owed" : undefined;

  const { rows, pagination } = await listSuppliers({ q, activeFilter, owedOnly: balanceFilter === "owed" }, page, perPage);
  const balances = canViewProfit ? await getSupplierBalances(rows.map((row) => row.id)) : null;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/suppliers")} />
      <PageHeader
        title="Supplier"
        description="Daftar supplier kain, aksesoris, dan penjahit beserta kontak dan rekeningnya."
        actions={
          canManage ? (
            <Link href="/suppliers/new">
              <Button>Tambah supplier</Button>
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <Tabs
          aria-label="Filter status supplier"
          items={ACTIVE_FILTER_OPTIONS.map((option) => ({
            label: option.label,
            href: listHref({ status: option.value, balance: balanceFilter, q }),
            isActive: option.value === activeFilter,
          }))}
        />
        {canViewProfit && (
          <Tabs
            aria-label="Filter utang supplier"
            items={BALANCE_FILTER_OPTIONS.map((option) => ({
              label: option.label,
              href: listHref({ status: activeFilter, balance: option.value, q }),
              isActive: option.value === balanceFilter,
            }))}
          />
        )}
        <form method="GET">
          {activeFilter && <input type="hidden" name="status" value={activeFilter} />}
          {balanceFilter && <input type="hidden" name="balance" value={balanceFilter} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nama supplier..." aria-label="Cari supplier" />
        </form>
        {balanceFilter === "owed" && rows.length === 0 ? (
          <EmptyState title="Tidak ada utang" description="Tidak ada supplier dengan tagihan belum lunas yang cocok dengan filter atau pencarian ini." />
        ) : (
          <SupplierList
            // Projected explicitly, not spread: the list needs these fields, and address/bank
            // details have no business being serialized into the RSC payload for a page that
            // never renders them.
            rows={rows.map((row) => ({
              id: row.id,
              name: row.name,
              kinds: row.kinds,
              phone: row.phone,
              isActive: row.isActive,
              balance: balances?.get(row.id) ?? null,
            }))}
            canManage={canManage}
          />
        )}
      </div>
      <Pagination
        pagination={pagination}
        basePath="/suppliers"
        searchParams={{ q, status: activeFilter, balance: balanceFilter, perPage }}
        itemLabel="supplier"
      />
    </>
  );
}
