import { notFound } from "next/navigation";
import { Badge, Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { getExpenseCategory, listExpenseItems } from "@/lib/expense-categories/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { CategoryStatusControl } from "../_components/category-status-control";
import { ExpenseCategoryForm } from "../_components/expense-category-form";
import { ExpenseItemsSection } from "../_components/expense-items-section";
import { SystemBadge } from "../_components/system-badge";

// docs/plans/expense-master-data.md §3.6: edit name and order (code and kind read-only),
// Nonaktifkan/Aktifkan (not for system categories), and the category's "Item biaya".
export default async function ExpenseCategoryDetailPage({ params }: { params: Promise<{ code: string }> }) {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const { code } = await params;
  // getExpenseCategory returns null for anything that isn't a well-formed code, so a hand-typed
  // URL is a 404, never a query error.
  const [category, items] = await Promise.all([getExpenseCategory(code), listExpenseItems(code)]);
  if (!category) notFound();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/expense-categories"), { label: category.name }]} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeader title={category.name} description={`Kode ${category.code}`} />
        <div className="flex items-center gap-2">
          {category.isSystem && <SystemBadge />}
          {!category.isActive && <Badge variant="neutral">Nonaktif</Badge>}
        </div>
      </div>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <ExpenseCategoryForm
            // Remount on a server-side change (a rename from another tab) so the inputs resync.
            key={`${category.name}:${category.sortOrder}`}
            mode="edit"
            code={category.code}
            kind={category.kind}
            initialValues={{ name: category.name, sortOrder: String(category.sortOrder) }}
          />
          <CategoryStatusControl code={category.code} name={category.name} isActive={category.isActive} isSystem={category.isSystem} />
        </div>
        <ExpenseItemsSection categoryCode={category.code} items={items} />
      </div>
    </>
  );
}
