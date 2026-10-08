import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FabricForm } from "../_components/fabric-form";

export default async function BahanBaruPage() {
  await requirePermission("products.manage");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/fabrics"), { label: "Tambah bahan" }]} />
      <PageHeader title="Tambah Bahan" />
      <FabricForm />
    </>
  );
}
