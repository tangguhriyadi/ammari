import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccessoryForm } from "../_components/accessory-form";

export default async function NewAccessoryPage() {
  await requirePermission("inventory.manage");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accessories"), { label: "Tambah aksesoris" }]} />
      <PageHeader title="Tambah Aksesoris" />
      <AccessoryForm mode="create" initialValues={{ name: "", size: "", sizeGroup: "", isActive: true, notes: "" }} />
    </>
  );
}
