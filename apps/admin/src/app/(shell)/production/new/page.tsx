import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listActiveCostComponents } from "@/lib/production/cost-components";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { ProductionBatchForm } from "../_components/production-batch-form";

export default async function NewProductionBatchPage() {
  const session = await requirePermission("production.manage");
  const { rows: fabrics } = await listFabricsWithUsage(undefined, undefined);
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const activeCostComponents = canViewProfit ? await listActiveCostComponents() : [];

  return (
    <>
      <PageHeader title="Batch produksi baru" />
      <ProductionBatchForm
        mode="create"
        fabrics={fabrics.map((fabric) => ({ id: fabric.id, name: fabric.name }))}
        initialValues={{ fabricId: "", producedAt: todayInJakarta(), fabricYards: null, notes: "", lines: [] }}
        eligibleSkus={[]}
        canViewProfit={canViewProfit}
        initialExtraCosts={canViewProfit ? [] : undefined}
        activeCostComponents={activeCostComponents}
      />
    </>
  );
}
