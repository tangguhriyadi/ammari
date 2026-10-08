import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getCostComponentById } from "@/lib/production/cost-components";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { CostComponentForm } from "../_components/cost-component-form";

export default async function EditCostComponentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("finance.view_profit");
  const { id } = await params;
  const component = await getCostComponentById(id);
  if (!component) notFound();

  return (
    <>
      <Breadcrumb
        items={[...rootCrumbs("/production"), { label: "Komponen Biaya", href: "/production/cost-components" }, { label: component.name }]}
      />
      <PageHeader title={component.name} />
      <CostComponentForm
        mode="edit"
        componentId={component.id}
        initialValues={{
          name: component.name,
          unit: component.unit,
          defaultUnitPrice: component.defaultUnitPrice !== null ? String(component.defaultUnitPrice) : "",
          costType: component.costType,
          isActive: component.isActive,
          sortOrder: component.sortOrder,
        }}
      />
    </>
  );
}
