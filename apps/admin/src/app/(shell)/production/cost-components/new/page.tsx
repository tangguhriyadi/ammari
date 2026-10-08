import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { CostComponentForm } from "../_components/cost-component-form";

export default async function NewCostComponentPage() {
  await requirePermission("finance.view_profit");

  return (
    <>
      <PageHeader title="Komponen biaya baru" />
      <CostComponentForm
        mode="create"
        initialValues={{ name: "", unit: "pcs", defaultUnitPrice: "", isActive: true, sortOrder: 0 }}
      />
    </>
  );
}
