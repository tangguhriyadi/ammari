import { notFound } from "next/navigation";
import { isUuid } from "@/lib/purchases/queries";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getBatchDetail, getBatchExtraCosts, listEligibleSkusForFabric } from "@/lib/production/queries";
import { getBatchReceiptSummary, listReceiptsForBatch } from "@/lib/receipts/production";
import { getLineDefectTotals, heldDefectValue, listDefectMovementsForBatch, stripDefectMovementAmounts } from "@/lib/defects/queries";
import type { LineDefectTotals } from "@/lib/defects/valuation";
import { listActiveCostComponents } from "@/lib/production/cost-components";
import { getFabricBalance } from "@/lib/inventory/fabric-stock";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { listActiveSupplierOptions } from "@/lib/suppliers/queries";
import { ProductionBatchForm } from "../_components/production-batch-form";
import { ProductionBatchReadOnly } from "../_components/production-batch-readonly";
import { BatchStatusBadge } from "../_components/production-batch-list";
import { BatchOutputSection } from "../_components/batch-output-section";
import { BatchCostsSection } from "../_components/batch-costs-section";
import { AccessoryNeedsSection } from "../_components/accessory-needs-section";
import { DraftControls } from "../_components/draft-controls";

export default async function ProductionBatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("production.manage");
  const { id } = await params;
  // A malformed id would otherwise reach Postgres as a uuid cast error (a 500), not a 404.
  if (!isUuid(id)) notFound();
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
        <PostedView batch={batch} canViewProfit={canViewProfit} permissionKeys={session.permissionKeys} />
      ) : (
        <DraftView batch={batch} canViewProfit={canViewProfit} />
      )}
    </>
  );
}

async function PostedView({
  batch,
  canViewProfit,
  permissionKeys,
}: {
  batch: NonNullable<Awaited<ReturnType<typeof getBatchDetail>>>;
  canViewProfit: boolean;
  permissionKeys: readonly string[];
}) {
  const [summary, receipts, defectRowsRaw] = await Promise.all([
    getBatchReceiptSummary(batch.id),
    listReceiptsForBatch(batch.id),
    listDefectMovementsForBatch(batch.id),
  ]);
  if (!summary) notFound();
  const defectRows = stripDefectMovementAmounts(defectRowsRaw, canViewProfit);
  const canManage = permissionKeys.includes("inventory.manage");
  // Cost data (the disposal dialog's live value preview): only for finance.view_profit.
  const heldLineIds = canManage && canViewProfit ? summary.lines.filter((line) => line.defectHeld > 0).map((line) => line.id) : [];
  const lineTotals = new Map<string, LineDefectTotals>(
    await Promise.all(heldLineIds.map(async (id) => [id, await getLineDefectTotals({ productionBatchItemId: id })] as const)),
  );

  return (
    <>
      <ProductionBatchReadOnly batch={batch} />
      <div className="mt-6">
        <BatchOutputSection
          batchId={batch.id}
          summary={summary}
          receipts={receipts}
          defectRows={defectRows}
          defectValue={defectRows.length > 0 ? heldDefectValue(defectRows) : null}
          // Receiving needs inventory.receive (D10); the receive page also needs production.manage,
          // which this page already required.
          canReceive={permissionKeys.includes("inventory.receive")}
          canManage={canManage}
          lineTotals={lineTotals}
        />
      </div>
      {canViewProfit && (
        <div className="mt-6">
          <BatchCostsSection batchId={batch.id} fabricYards={batch.fabricYards} lines={batch.lines} receiptSummary={summary} defectRows={defectRowsRaw} />
        </div>
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
  const supplierOptions = canViewProfit ? await listActiveSupplierOptions("service") : [];
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
                supplierId: line.supplierId ?? "",
                currentSupplier:
                  line.supplierId !== null && line.supplierName !== null
                    ? { id: line.supplierId, name: line.supplierName, isActive: line.supplierIsActive ?? false }
                    : null,
              }))
            : undefined
        }
        activeCostComponents={activeCostComponents}
        supplierOptions={supplierOptions}
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
