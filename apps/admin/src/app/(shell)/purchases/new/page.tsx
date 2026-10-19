import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listActiveFabrics } from "@/lib/products/fabric-queries";
import { listActiveAccessories } from "@/lib/inventory/accessories";
import { listActiveSupplierOptions } from "@/lib/suppliers/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PurchaseForm } from "../_components/purchase-form";

export default async function NewPurchasePage() {
  await requirePermission("inventory.manage");

  const [suppliers, fabrics, accessories] = await Promise.all([listActiveSupplierOptions(undefined), listActiveFabrics(), listActiveAccessories()]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/purchases"), { label: "Buat pesanan" }]} />
      <PageHeader title="Buat pesanan pembelian" description="Catat bahan atau aksesoris yang dipesan. Stok baru bertambah saat barang diterima." />
      <PurchaseForm
        mode="create"
        suppliers={suppliers}
        fabrics={fabrics.map((fabric) => ({ id: fabric.id, name: fabric.name }))}
        accessories={accessories.map((accessory) => ({ id: accessory.id, name: accessory.name }))}
      />
    </>
  );
}
