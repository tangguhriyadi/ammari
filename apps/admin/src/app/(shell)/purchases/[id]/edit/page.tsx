import { notFound, redirect } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listActiveFabrics } from "@/lib/products/fabric-queries";
import { listActiveAccessories } from "@/lib/inventory/accessories";
import { getPurchaseDocument, isUuid } from "@/lib/purchases/queries";
import { listActiveSupplierOptions } from "@/lib/suppliers/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PurchaseForm } from "../../_components/purchase-form";

/** Editing is allowed only while nothing has been received and the document is still open (D7);
 * updatePurchase re-checks that on the server, this page only avoids showing a form that would
 * be refused. Line totals are cost data, so editing needs finance.view_profit too: without it the
 * form could not show (or keep) what was paid. */
export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("inventory.manage");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const document = await getPurchaseDocument(id);
  if (!document) notFound();
  if (document.status !== "ordered" || document.hasReceipts || !session.permissionKeys.includes("finance.view_profit")) {
    redirect(`/purchases/${id}`);
  }

  const [suppliers, fabrics, accessories] = await Promise.all([listActiveSupplierOptions(undefined), listActiveFabrics(), listActiveAccessories()]);
  const accessoryOptions = accessories.map((accessory) => ({ id: accessory.id, name: accessory.name }));
  // A line's accessory deactivated since the order was placed must still show as selected.
  for (const line of document.lines) {
    if (line.itemType === "accessory" && !accessoryOptions.some((option) => option.id === line.itemId)) {
      accessoryOptions.push({ id: line.itemId, name: `${line.itemName} (nonaktif)` });
    }
  }

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: document.purchaseNo, href: `/purchases/${id}` }, { label: "Ubah" }]} />
      <PageHeader title={`Ubah ${document.purchaseNo}`} />
      <PurchaseForm
        mode="edit"
        purchaseId={id}
        suppliers={suppliers}
        currentSupplier={{ id: document.supplierId, name: document.supplierName }}
        fabrics={fabrics.map((fabric) => ({ id: fabric.id, name: fabric.name }))}
        accessories={accessoryOptions}
        initialValues={{
          supplierId: document.supplierId,
          orderedAt: document.orderedAt,
          notes: document.notes ?? "",
          lines: document.lines.map((line) => ({
            itemType: line.itemType,
            itemId: line.itemId,
            qtyOrdered: String(line.qtyOrdered),
            totalAmount: String(line.totalAmountPaid ?? 0),
          })),
        }}
      />
    </>
  );
}
