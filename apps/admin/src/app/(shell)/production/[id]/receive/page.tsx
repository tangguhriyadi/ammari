import { notFound, redirect } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { isUuid } from "@/lib/purchases/queries";
import { getBatchDetail } from "@/lib/production/queries";
import { isOpenBatchReceiptStatus } from "@/lib/production/receipt-status";
import { getBatchReceiptSummary } from "@/lib/receipts/production";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ReceiveForm } from "../../../purchases/_components/receive-form";

/** "Terima hasil" (inventory.receive, D10) for a posted batch's output — its own page, like the
 * purchase receipt: the person using it is standing next to the finished goods with a phone.
 * Quantities only, never cost. */
export default async function ReceiveBatchOutputPage({ params }: { params: Promise<{ id: string }> }) {
  // production.manage too: after saving (and on "Batal") the receiver lands on the batch detail
  // page, which needs it — a receive-only role would otherwise be sent to a 403.
  const session = await requireAllPermissions(["inventory.receive", "production.manage"]);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const batch = await getBatchDetail(id);
  if (!batch) notFound();
  if (batch.status !== "posted") redirect(`/production/${id}`);
  const summary = await getBatchReceiptSummary(id);
  if (!summary) notFound();
  // The summary's effective status, not the stored one — see BatchReceiptSummary.receiptStatus.
  if (!isOpenBatchReceiptStatus(summary.receiptStatus)) redirect(`/production/${id}`);
  // Open but nothing left to receive: every line is fully settled, some of it as defects (S5).
  const openLines = summary.lines.filter((line) => line.outstanding > 0);
  if (openLines.length === 0) redirect(`/production/${id}`);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/production"), { label: batch.batchNo, href: `/production/${id}` }, { label: "Terima hasil" }]} />
      <PageHeader title="Terima hasil produksi" description={`${batch.batchNo} · ${batch.fabricName}`} />
      <ReceiveForm
        source={{ type: "production_batch", batchId: id }}
        receiverName={session.staffUser.name}
        lines={openLines.map((line) => ({
          id: line.id,
          itemName: `${line.productName} · ${line.colorName} · ${line.size === "ALLSIZE" ? "All Size" : line.size}`,
          unit: "pcs",
          wholeOnly: true,
          outstanding: line.outstanding,
          planned: line.planned,
          received: line.received,
          rejected: line.rejected,
        }))}
      />
    </>
  );
}
