import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { getCapitalizationThreshold, listFixedAssetGroups } from "@/lib/accounting/fixed-assets";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { GroupForm, ThresholdForm } from "../_components/settings-forms";

// Pengaturan aset tetap (D-19): the tax groups' useful life and the capitalisation threshold.
// accounting.view + accounting.manage; each change is audited.
export default async function FixedAssetSettingsPage() {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const [groups, threshold] = await Promise.all([listFixedAssetGroups(), getCapitalizationThreshold()]);
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/fixed-assets"), { label: "Pengaturan" }]} />
      <PageHeader
        title="Pengaturan Aset Tetap"
        description="Umur manfaat per kelompok pajak dan batas kapitalisasi. Perubahan umur berlaku untuk aset yang dicatat atau dipindah kelompok sesudahnya; aset lain tetap memakai umurnya sendiri."
      />
      <div className="flex max-w-xl flex-col gap-4">
        {groups.map((group) => (
          <GroupForm key={group.code} group={group} />
        ))}
        <ThresholdForm threshold={threshold} />
      </div>
    </>
  );
}
