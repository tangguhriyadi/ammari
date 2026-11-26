import Link from "next/link";
import { Breadcrumb, Button, FilterTabs, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { cashBankAccounts, listAccounts } from "@/lib/accounting/accounts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccountList } from "./_components/account-list";

// Data Master Akun (docs/plans/accounting.md Session 3, §5.2): the Chart of Accounts. Read with
// accounting.view; adding and editing need accounting.manage too (the button is hidden without it,
// and every action re-checks). "Kas & Bank" lists the active postable cash and bank accounts
// (D-17: today Kas tunai and Bank utama), the same list payment methods map to.

const FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Kas & Bank", value: "cash-bank" },
  { label: "Nonaktif", value: "inactive" },
] as const;

type Filter = "cash-bank" | "inactive" | undefined;

function parseFilter(raw: string | string[] | undefined): Filter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "cash-bank" || value === "inactive" ? value : undefined;
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const filter = parseFilter((await searchParams).filter);
  const rows = await listAccounts();
  const shown = filter === "cash-bank" ? cashBankAccounts(rows) : filter === "inactive" ? rows.filter((row) => !row.isActive) : rows;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/accounts")} />
      <PageHeader
        title="Akun"
        description="Daftar akun pembukuan. Akun sistem dipakai jurnal otomatis: bisa diganti nama, tapi tidak bisa dinonaktifkan atau dihapus. Akun yang sudah dipakai jurnal tidak bisa dihapus."
        actions={
          canManage ? (
            <Link href="/accounting/accounts/new">
              <Button>Tambah akun</Button>
            </Link>
          ) : undefined
        }
      />
      <FilterTabs basePath="/accounting/accounts" paramName="filter" options={FILTER_OPTIONS} activeValue={filter} aria-label="Filter akun" />
      <AccountList
        rows={shown}
        emptyText={filter === "inactive" ? "Tidak ada akun nonaktif." : filter === "cash-bank" ? "Belum ada akun Kas & Bank yang aktif." : "Belum ada akun."}
      />
    </>
  );
}
