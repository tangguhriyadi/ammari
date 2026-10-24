import { Breadcrumb, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getSalesGoal } from "@/lib/overview/queries";
import { SalesGoalForm } from "./_components/sales-goal-form";

export default async function PengaturanPage() {
  await requirePermission("settings.manage");
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
