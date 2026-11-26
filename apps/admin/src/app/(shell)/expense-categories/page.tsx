import Link from "next/link";
import { Breadcrumb, Button, FilterTabs, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
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
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const status = parseStatus((await searchParams).status);
  const rows = await listExpenseCategories();
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
      <ExpenseCategoryList rows={shown} filtered={status !== undefined} />
    </>
  );
}
