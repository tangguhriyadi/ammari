import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { getFixedAssetFormChoices } from "@/lib/accounting/fixed-assets";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FixedAssetForm } from "../_components/fixed-asset-form";

// Catat aset tetap (D-19). accounting.view + accounting.manage.
export default async function NewFixedAssetPage() {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const choices = await getFixedAssetFormChoices();
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/fixed-assets"), { label: "Catat aset tetap" }]} />
      <PageHeader title="Catat Aset Tetap" description="Jurnal perolehan dan penyusutan bulanan dibuat saat posting berikutnya." />
      <FixedAssetForm
        mode="create"
        choices={choices}
        initialValues={{
          name: "",
          groupCode: choices.groups[0]?.code ?? "",
          acquisitionDate: "",
          cost: "",
          assetAccountCode: "",
          accumulatedAccountCode: "",
          fundingAccountCode: "",
          note: "",
        }}
      />
    </>
  );
}
