import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SupplierForm } from "../_components/supplier-form";

export default async function NewSupplierPage() {
  await requirePermission("inventory.manage");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/suppliers"), { label: "Tambah supplier" }]} />
      <PageHeader title="Tambah Supplier" />
      <SupplierForm
        mode="create"
        initialValues={{
          name: "",
          kinds: [],
          phone: "",
          address: "",
          bankName: "",
          bankAccountNo: "",
          bankAccountName: "",
          notes: "",
          isActive: true,
        }}
      />
    </>
  );
}
