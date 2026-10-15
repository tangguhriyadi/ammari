import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SizeChartForm } from "../_components/size-chart-form";

export default async function SizeChartBaruPage() {
  await requirePermission("content.manage");

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content/size-charts"), { label: "Tambah size chart" }]} />
      <PageHeader title="Tambah Size Chart" />
      <SizeChartForm />
    </>
  );
}
