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
        fabrics={fabrics.map((fabric) => ({
          id: fabric.id,
          name: fabric.name,
          // Never shipped to a session without finance.view_profit — same contract as
          // initialCosts/initialExtraCosts/activeCostComponents below, not just unused by the
          // form's own (already-gated) cost suggestion.
          priceAmount: canViewProfit ? fabric.priceAmount : null,
          priceUnit: canViewProfit ? fabric.priceUnit : null,
        }))}
        initialValues={{ fabricId: "", producedAt: todayInJakarta(), fabricYards: null, notes: "", lines: [] }}
        eligibleSkus={[]}
        initialCosts={canViewProfit ? { fabricCostAmount: "" } : undefined}
        initialExtraCosts={canViewProfit ? [] : undefined}
        activeCostComponents={activeCostComponents}
      />
    </>
  );
}
