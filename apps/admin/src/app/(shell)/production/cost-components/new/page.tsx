import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { listActiveSupplierOptions } from "@/lib/suppliers/queries";
import { CostComponentForm } from "../_components/cost-component-form";

export default async function NewCostComponentPage() {
  await requirePermission("finance.view_profit");
  const supplierOptions = await listActiveSupplierOptions("service");

  return (
    <>
      <Breadcrumb
        items={[...rootCrumbs("/production"), { label: "Komponen Biaya", href: "/production/cost-components" }, { label: "Tambah komponen" }]}
      />
      <PageHeader title="Komponen biaya baru" />
      <CostComponentForm
        mode="create"
        initialValues={{
          name: "",
          unit: "pcs",
          defaultUnitPrice: "",
          costType: "variable",
          isActive: true,
          sortOrder: 0,
          defaultSupplierId: "",
        }}
        supplierOptions={supplierOptions}
      />
    </>
  );
}
