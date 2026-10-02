import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { FabricForm } from "../_components/fabric-form";

export default async function BahanBaruPage() {
  await requirePermission("products.manage");
  return (
    <>
      <PageHeader title="Tambah Bahan" />
      <FabricForm />
    </>
  );
}
