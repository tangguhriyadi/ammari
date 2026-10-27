import Link from "next/link";
import { Breadcrumb, Button, Checkbox, Input, Label, PageHeader, Pagination, Select, Tabs } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listCustomers } from "@/lib/customers/directory";
import {
  CUSTOMER_FILTERS,
  CUSTOMER_FILTER_LABELS,
  CUSTOMER_SORTS,
  CUSTOMER_SORT_LABELS,
  customerListHref,
  parseCustomerListParams,
  parseCustomersTab,
  parseVoucherTabParams,
  voucherTabHref,
} from "@/lib/customers/search-params";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { CustomerList } from "./_components/customer-list";
import { PromoExportButton } from "./_components/promo-export-button";
import { VoucherTab } from "./_components/voucher-tab";

// Pelanggan & Voucher (docs/plans/growth.md §8, §9; sessions S4 and S5). customers.view (owner,
// super_admin, CS). Read-only for identity (A10). Tab "Pelanggan" lists customers with masked
// contacts (A5), hiding by default those with no counted order and no account (A13); tab
// "Voucher" (`?tab=voucher`) is the voucher overview. Session S6: "Unduh kontak promo" in the
// header for customers.export (A9; the route re-checks).

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("customers.view");
  const raw = await searchParams;
  const tab = parseCustomersTab(raw);
  const page = typeof raw.page === "string" ? raw.page : undefined;
  const perPage = typeof raw.perPage === "string" ? raw.perPage : undefined;

  const header = (
    <>
      <Breadcrumb items={rootCrumbs("/customers")} />
      <PageHeader
        title="Pelanggan & Voucher"
        description="Data pelanggan dan voucher kartu terima kasih. Data pribadi, hanya untuk keperluan layanan."
        actions={session.permissionKeys.includes("customers.export") ? <PromoExportButton /> : undefined}
      />
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <Tabs
          aria-label="Bagian Pelanggan & Voucher"
          items={[
            { label: "Pelanggan", href: "/customers", isActive: tab === "customers" },
            { label: "Voucher", href: voucherTabHref({}), isActive: tab === "vouchers" },
          ]}
        />
      </div>
    </>
  );

  if (tab === "vouchers") {
    return (
      <>
        {header}
        <VoucherTab params={parseVoucherTabParams(raw)} canViewProfit={session.permissionKeys.includes("finance.view_profit")} rawPage={page} rawPerPage={perPage} />
      </>
    );
  }

  const params = parseCustomerListParams(raw);
  const { rows, pagination } = await listCustomers(params, page, perPage);

  return (
    <>
      {header}
      <div className="flex flex-col gap-3">
        <Tabs
          aria-label="Filter pelanggan"
          items={[undefined, ...CUSTOMER_FILTERS].map((filter) => ({
            label: CUSTOMER_FILTER_LABELS[filter ?? "all"],
            href: customerListHref({ ...params, filter }),
            isActive: filter === params.filter,
          }))}
        />
        <form method="GET" action="/customers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" aria-label="Cari pelanggan">
          {params.filter && <input type="hidden" name="filter" value={params.filter} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer-q">Cari</Label>
            <Input id="customer-q" name="q" defaultValue={params.q ?? ""} placeholder="Nama, email, atau nomor HP" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer-sort">Urutkan</Label>
            <Select id="customer-sort" name="sort" defaultValue={params.sort}>
              {CUSTOMER_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {CUSTOMER_SORT_LABELS[sort]}
                </option>
              ))}
            </Select>
          </div>
          <Checkbox name="all" value="1" defaultChecked={params.includeNonBuyers} label="Termasuk yang belum pernah belanja" />
          <div className="flex items-center gap-3">
            <Button type="submit">Terapkan</Button>
            <Link href="/customers" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          </div>
        </form>
        {!params.includeNonBuyers && (
          <p className="text-sm text-neutral-600">Pelanggan tanpa akun yang belum pernah belanja tidak ditampilkan.</p>
        )}
        <CustomerList rows={rows} />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/customers"
        searchParams={{
          filter: params.filter,
          sort: params.sort === "newest" ? undefined : params.sort,
          q: params.q,
          all: params.includeNonBuyers ? "1" : undefined,
          perPage,
        }}
        itemLabel="pelanggan"
      />
    </>
  );
}
