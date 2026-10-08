import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getBatchDetail, getBatchExtraCosts, listEligibleSkusForFabric } from "@/lib/production/queries";
import { listActiveCostComponents } from "@/lib/production/cost-components";
import { getFabricBalance } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductionBatchForm } from "../_components/production-batch-form";
import { ProductionBatchReadOnly } from "../_components/production-batch-readonly";
import { BatchStatusBadge } from "../_components/production-batch-list";
import { BatchCostsSection } from "../_components/batch-costs-section";
import { AccessoryNeedsSection } from "../_components/accessory-needs-section";
import { DraftControls } from "../_components/draft-controls";

export default async function ProductionBatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("production.manage");
  const { id } = await params;
  const batch = await getBatchDetail(id);
  if (!batch) notFound();

  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/production"), { label: batch.batchNo }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={batch.batchNo} />
        <BatchStatusBadge status={batch.status} />
      </div>

      {batch.status === "posted" ? (
        <>
          <ProductionBatchReadOnly batch={batch} />
          {canViewProfit && (
            <div className="mt-6">
              <BatchCostsSection batchId={batch.id} fabricYards={batch.fabricYards} lines={batch.lines} />
            </div>
          )}
        </>
      ) : (
        <DraftView batch={batch} canViewProfit={canViewProfit} />
      )}
    </>
  );
}

async function DraftView({
  batch,
  canViewProfit,
}: {
  batch: NonNullable<Awaited<ReturnType<typeof getBatchDetail>>>;
  canViewProfit: boolean;
}) {
  const eligibleSkus = await listEligibleSkusForFabric(batch.fabricId);

  // Never fetched at all for a session without finance.view_profit — same ProductBatasHpp
  // pattern used by products/[id]/page.tsx.
  const extraCosts = canViewProfit ? await getBatchExtraCosts(batch.id) : [];
  const activeCostComponents = canViewProfit ? await listActiveCostComponents() : [];
  const fabricBalance = canViewProfit ? await getFabricBalance(batch.fabricId) : { qty: 0, valueAmount: 0 };

  return (
    <>
      <ProductionBatchForm
        mode="edit"
        batchId={batch.id}
        fixedFabricName={batch.fabricName}
        // Never shipped to a session without finance.view_profit — same contract as new/page.tsx.
        fixedFabricBalance={fabricBalance}
        initialValues={{
          fabricId: batch.fabricId,
          producedAt: batch.producedAt,
          fabricYards: batch.fabricYards,
          notes: batch.notes ?? "",
          lines: batch.lines.map((line) => ({ sku: line.sku, qty: line.qty })),
        }}
        eligibleSkus={eligibleSkus}
        canViewProfit={canViewProfit}
        initialExtraCosts={
          canViewProfit
            ? extraCosts.map((line) => ({
                id: line.id,
                clientKey: line.id, // already stable (a real server row) — no need to mint a new one
                costComponentId: line.costComponentId,
                componentName: line.componentName,
                costType: line.costType,
                unitPrice: String(line.unitPrice),
              }))
            : undefined
        }
        activeCostComponents={activeCostComponents}
      />
      <div className="mt-6">
        <AccessoryNeedsSection batchId={batch.id} />
      </div>
      <div className="mt-6">
        <DraftControls batchId={batch.id} canPost={canViewProfit} />
      </div>
    </>
  );
}
