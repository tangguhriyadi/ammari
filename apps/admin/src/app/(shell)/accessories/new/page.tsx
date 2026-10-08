import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { AccessoryForm } from "../_components/accessory-form";

export default async function NewAccessoryPage() {
  await requirePermission("inventory.manage");
  return (
    <>
      <PageHeader title="Tambah Aksesoris" />
      <AccessoryForm mode="create" initialValues={{ name: "", size: "", sizeGroup: "", isActive: true, notes: "" }} />
    </>
  );
}
