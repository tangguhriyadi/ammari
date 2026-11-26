import Link from "next/link";
import { Breadcrumb, Button, FilterTabs, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { getExpenseMappingWarnings } from "@/lib/accounting/mappings";
import { listExpenseCategories } from "@/lib/expense-categories/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ExpenseCategoryList } from "./_components/expense-category-list";

// docs/plans/expense-master-data.md §3.6 (session S3): the "Kategori Biaya" master. Same
// permission pair as recording an expense (owner answer D5).

const STATUS_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "active" },
  { label: "Nonaktif", value: "inactive" },
] as const;

type StatusFilter = "active" | "inactive" | undefined;

function parseStatus(raw: string | string[] | undefined): StatusFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "active" || value === "inactive" ? value : undefined;
}

export default async function ExpenseCategoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const status = parseStatus((await searchParams).status);
  // D-25 (docs/plans/accounting.md Session 3): a category must be mapped to an account before its
  // expenses can be posted. Shown only to staff who may see the books (accounting.view).
  const canSeeBooks = session.permissionKeys.includes("accounting.view");
  const [rows, mapping] = await Promise.all([listExpenseCategories(), canSeeBooks ? getExpenseMappingWarnings() : null]);
  const shown = status === undefined ? rows : rows.filter((row) => row.isActive === (status === "active"));

  return (
    <>
      <Breadcrumb items={rootCrumbs("/expense-categories")} />
      <PageHeader
        title="Kategori Biaya"
        description="Kategori dan item biaya yang dipilih saat mencatat biaya. Yang dinonaktifkan tidak bisa dipilih untuk biaya baru, tapi tetap tampil di biaya dan laporan yang sudah memakainya."
        actions={
          <Link href="/expense-categories/new">
            <Button>Tambah kategori</Button>
          </Link>
        }
      />
      <FilterTabs basePath="/expense-categories" paramName="status" options={STATUS_OPTIONS} activeValue={status} aria-label="Filter status kategori" />
      {mapping && (mapping.unmapped.length > 0 || mapping.openIssueCount > 0) && (
        <section aria-label="Pemetaan akun" className="mb-4 rounded-lg border border-warning-700/30 bg-warning-50 p-4 text-base">
          {mapping.unmapped.length > 0 && (
            <p className="text-warning-700">
              Belum dipetakan ke akun: {mapping.unmapped.map((category) => category.name).join(", ")}. Biaya di kategori ini belum bisa dibukukan.
            </p>
          )}
          {mapping.openIssueCount > 0 && (
            <p className="text-warning-700">{mapping.openIssueCount} biaya menunggu dibukukan karena pemetaan akun kategorinya.</p>
          )}
          <Link href="/accounting/mappings" className="mt-1 inline-flex min-h-11 items-center font-medium text-brand hover:underline">
            Atur pemetaan akun
          </Link>
        </section>
      )}
      <ExpenseCategoryList
        rows={shown}
        filtered={status !== undefined}
        unmappedCodes={mapping ? new Set(mapping.unmapped.map((category) => category.code)) : undefined}
      />
    </>
  );
}
