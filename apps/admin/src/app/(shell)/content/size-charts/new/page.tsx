import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SizeChartForm } from "../_components/size-chart-form";

export default async function SizeChartBaruPage() {
  await requirePermission("content.manage");

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content/size-charts"), { label: "Tambah tabel ukuran" }]} />
      <PageHeader title="Tambah Tabel Ukuran" />
      <SizeChartForm />
    </>
  );
}
