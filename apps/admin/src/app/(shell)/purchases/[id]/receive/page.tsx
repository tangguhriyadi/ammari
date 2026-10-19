import { notFound, redirect } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { isUuid } from "@/lib/purchases/queries";
import { getPurchaseDocument } from "@/lib/purchases/queries";
import { isOpenPurchaseStatus } from "@/lib/purchases/status";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ReceiveForm } from "../../_components/receive-form";

/** "Terima barang" (inventory.receive, D10) — its own page rather than a dialog: the person using
 * it is standing next to the delivery with a phone. Only quantities are shown, never prices. */
export default async function ReceivePurchasePage({ params }: { params: Promise<{ id: string }> }) {
  // inventory.view too: after saving (and on "Batal") the receiver lands on the detail page,
  // which needs it — a receive-only role would otherwise be sent to a 403.
  const session = await requireAllPermissions(["inventory.receive", "inventory.view"]);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const document = await getPurchaseDocument(id);
  if (!document) notFound();
  if (!isOpenPurchaseStatus(document.status)) redirect(`/purchases/${id}`);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: document.purchaseNo, href: `/purchases/${id}` }, { label: "Terima barang" }]} />
      <PageHeader title="Terima barang" description={`${document.purchaseNo} · ${document.supplierName}`} />
      <ReceiveForm
        source={{ type: "purchase", purchaseId: id }}
        receiverName={session.staffUser.name}
        lines={document.lines
          .filter((line) => line.outstanding > 0)
          .map((line) => ({
            id: line.id,
            itemName: line.itemName,
            unit: line.itemType === "fabric" ? "yard" : "pcs",
            wholeOnly: line.itemType === "accessory",
            outstanding: line.outstanding,
          }))}
      />
    </>
  );
}
