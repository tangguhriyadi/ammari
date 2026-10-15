import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getSizeChartDetail, listSizeCharts } from "@/lib/content/size-charts";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SizeChartForm, type SizeChartRowValues } from "../_components/size-chart-form";

export default async function SizeChartDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("content.manage");
  const { id } = await params;
  const chart = await getSizeChartDetail(id);
  if (!chart) notFound();

  const charts = await listSizeCharts();
  const productCount = charts.find((candidate) => candidate.id === id)?.productCount ?? 0;

  const rows: SizeChartRowValues[] = chart.rows.map((row) => ({
    size: row.size,
    bustCm: String(row.bustCm),
    lengthCm: String(row.lengthCm),
    sleeveLengthCm: String(row.sleeveLengthCm),
    heightRecommendationMinCm: String(row.heightRecommendationMinCm),
    heightRecommendationMaxCm: String(row.heightRecommendationMaxCm),
  }));

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content/size-charts"), { label: chart.name }]} />
      <PageHeader title={chart.name} />
      <SizeChartForm chartId={chart.id} initialValues={{ name: chart.name, rows }} productCount={productCount} />
    </>
  );
}
