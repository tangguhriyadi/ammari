import { Breadcrumb, EmptyState, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getSalesGoal } from "@/lib/overview/queries";
import { canManageSalesGoal } from "@/lib/settings/sales-goal-permissions";
import { SalesGoalForm } from "./_components/sales-goal-form";

export default async function PengaturanPage() {
  const session = await requirePermission("settings.manage");
  // "Target penjualan" is a revenue figure: without finance.view_profit the section is not
  // rendered and the goal row is never read, so its amount cannot reach the page payload.
  if (!canManageSalesGoal(session.permissionKeys)) {
    return (
      <>
        <Breadcrumb items={rootCrumbs("/settings")} />
        <PageHeader title="Pengaturan" />
        <EmptyState title="Belum ada pengaturan untuk peran Anda" description="Pengaturan lain akan muncul di sini." />
      </>
    );
  }

  const goal = await getSalesGoal();
  const startDate = goal?.startDate ?? "";

  return (
    <>
      <Breadcrumb items={rootCrumbs("/settings")} />
      <PageHeader title="Pengaturan" description="Target penjualan dan pengaturan lain untuk Ringkasan." />
      <SalesGoalForm
        initialValues={{ revenueTargetDigits: goal ? String(goal.revenueTargetAmount) : "", startDate }}
        today={jakartaDate()}
      />
    </>
  );
}
