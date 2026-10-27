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
import { BatchPaymentSection, DraftPaymentNotice } from "../_components/batch-payment-section";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";
import { getBatchPaymentSummary, listBatchPayments } from "@/lib/supplier-payments/batch-payments";

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
  // Supplier payments (docs/plans/purchase-payments.md §7, S4): the status badge for every viewer
  // (A8); amounts and history only for finance.view_profit, queried only then.
  const canRecordPayments = canViewProfit && permissionKeys.includes("supplier_payments.manage");
  const [summary, receipts, defectRowsRaw, paymentSummary, payments] = await Promise.all([
    getBatchReceiptSummary(batch.id),
    listReceiptsForBatch(batch.id),
    listDefectMovementsForBatch(batch.id),
    getBatchPaymentSummary(batch.id),
    canViewProfit ? listBatchPayments(batch.id) : Promise.resolve([]),
  ]);
  if (!summary || !paymentSummary) notFound();
  const defectRows = stripDefectMovementAmounts(defectRowsRaw, canViewProfit);
  const canManage = permissionKeys.includes("inventory.manage");
  // Cost data (the disposal dialog's live value preview): only for finance.view_profit.
  const heldLineIds = canManage && canViewProfit ? summary.lines.filter((line) => line.defectHeld > 0).map((line) => line.id) : [];
  const lineTotals = new Map<string, LineDefectTotals>(
    await Promise.all(heldLineIds.map(async (id) => [id, await getLineDefectTotals({ productionBatchItemId: id })] as const)),
  );

  return (
    <>
      <p className="mb-4 flex items-center gap-2 text-sm text-neutral-600">
        Pembayaran <PaymentStatusBadge status={paymentSummary.overall.status} />
      </p>
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
      {canViewProfit && (
        <BatchPaymentSection batchId={batch.id} batchNo={batch.batchNo} summary={paymentSummary} payments={payments} canRecord={canRecordPayments} />
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
  // Cost data is never fetched at all for a session without finance.view_profit: same
  // ProductBatasHpp pattern used by products/[id]/page.tsx. Independent reads, so in parallel.
  const [eligibleSkus, extraCosts, activeCostComponents, supplierOptions, fabricBalance] = await Promise.all([
    listEligibleSkusForFabric(batch.fabricId),
    canViewProfit ? getBatchExtraCosts(batch.id) : Promise.resolve([]),
    canViewProfit ? listActiveCostComponents() : Promise.resolve([]),
    canViewProfit ? listActiveSupplierOptions("service") : Promise.resolve([]),
    canViewProfit ? getFabricBalance(batch.fabricId) : Promise.resolve({ qty: 0, valueAmount: 0 }),
  ]);

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
      {canViewProfit && <DraftPaymentNotice />}
    </>
  );
}
