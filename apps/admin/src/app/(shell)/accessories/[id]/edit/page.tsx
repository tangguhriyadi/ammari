import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAccessoryById } from "@/lib/inventory/accessories";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { AccessoryForm } from "../../_components/accessory-form";

export default async function EditAccessoryPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("inventory.manage");
  const { id } = await params;
  const accessory = await getAccessoryById(id);
  if (!accessory) notFound();

  return (
    <>
      <Breadcrumb
        items={[...rootCrumbs("/accessories"), { label: accessory.name, href: `/accessories/${id}` }, { label: "Edit" }]}
      />
      <PageHeader title={`Edit ${accessory.name}`} />
      <AccessoryForm
        mode="edit"
        accessoryId={accessory.id}
        initialValues={{
          name: accessory.name,
          size: accessory.size ?? "",
          sizeGroup: accessory.sizeGroup ?? "",
          isActive: accessory.isActive,
          notes: accessory.notes ?? "",
        }}
      />
    </>
  );
}
