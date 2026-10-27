import { Breadcrumb, EmptyState, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getSalesGoal } from "@/lib/overview/queries";
import { getMonthlyBillCategories } from "@/lib/settings/monthly-bills";
import { canManageSalesGoal } from "@/lib/settings/sales-goal-permissions";
import { MonthlyBillsForm } from "./_components/monthly-bills-form";
import { SalesGoalForm } from "./_components/sales-goal-form";

export default async function PengaturanPage() {
  const session = await requirePermission("settings.manage");
  // "Target penjualan" is a revenue figure and "Pengingat biaya bulanan" is about cost figures:
  // without finance.view_profit neither section is rendered and the row is never read, so nothing
  // of it can reach the page payload.
  if (!canManageSalesGoal(session.permissionKeys)) {
    return (
      <>
        <Breadcrumb items={rootCrumbs("/settings")} />
        <PageHeader title="Pengaturan" />
        <EmptyState title="Belum ada pengaturan untuk peran Anda" description="Pengaturan lain akan muncul di sini." />
      </>
    );
  }

  const [goal, monthlyBillCategories] = await Promise.all([getSalesGoal(), getMonthlyBillCategories()]);
  const startDate = goal?.startDate ?? "";

  return (
    <>
      <Breadcrumb items={rootCrumbs("/settings")} />
      <PageHeader title="Pengaturan" description="Target penjualan dan pengaturan lain untuk Ringkasan." />
      <div className="flex flex-col gap-10">
        <SalesGoalForm
          initialValues={{ revenueTargetDigits: goal ? String(goal.revenueTargetAmount) : "", startDate }}
          today={jakartaDate()}
        />
        <MonthlyBillsForm initialCategories={monthlyBillCategories} />
      </div>
    </>
  );
}
