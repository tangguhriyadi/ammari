import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SupplierForm } from "../_components/supplier-form";

export default async function NewSupplierPage() {
  await requirePermission("inventory.manage");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/suppliers"), { label: "Tambah pemasok" }]} />
      <PageHeader title="Tambah Pemasok" />
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
