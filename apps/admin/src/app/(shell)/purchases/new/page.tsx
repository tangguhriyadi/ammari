import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listActiveFabrics } from "@/lib/products/fabric-queries";
import { listActiveAccessories } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PurchaseForm } from "../_components/purchase-form";

export default async function NewPurchasePage() {
  await requirePermission("inventory.manage");

  const [fabrics, accessories] = await Promise.all([listActiveFabrics(), listActiveAccessories()]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: "Catat pembelian" }]} />
      <PageHeader title="Catat pembelian" description="Pembelian bahan atau aksesoris." />
      <PurchaseForm
        fabrics={fabrics.map((fabric) => ({ id: fabric.id, name: fabric.name }))}
        accessories={accessories.map((accessory) => ({ id: accessory.id, name: accessory.name }))}
      />
    </>
  );
}
