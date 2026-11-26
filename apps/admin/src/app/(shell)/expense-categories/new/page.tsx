import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ExpenseCategoryForm } from "../_components/expense-category-form";

export default async function NewExpenseCategoryPage() {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/expense-categories"), { label: "Tambah kategori" }]} />
      <PageHeader title="Tambah Kategori Biaya" description="Kode dibuat otomatis dari nama. Item biaya ditambahkan setelah kategori disimpan." />
      <ExpenseCategoryForm mode="create" />
    </>
  );
}
