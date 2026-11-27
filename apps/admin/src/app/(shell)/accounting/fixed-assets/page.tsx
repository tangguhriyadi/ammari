import Link from "next/link";
import { Breadcrumb, Button, Card, PageHeader } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getCapitalizationThreshold, listFixedAssetGroups, listFixedAssets } from "@/lib/accounting/fixed-assets";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FixedAssetList } from "./_components/fixed-asset-list";

// Aset tetap (docs/plans/accounting.md §5.3, D-19, Session 11): the register. accounting.view reads;
// accounting.manage records, edits, disposes and voids (audited). The acquisition, monthly
// depreciation and disposal journals are posted by "Posting sekarang".
export default async function FixedAssetsPage() {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const [rows, groups, threshold] = await Promise.all([listFixedAssets(), listFixedAssetGroups(), getCapitalizationThreshold()]);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/fixed-assets")} />
      <PageHeader
        title="Aset Tetap"
        description="Daftar aset tetap dan penyusutannya. Garis lurus mulai bulan perolehan, umur mengikuti kelompok pajak, tanpa nilai sisa. Jurnal perolehan, penyusutan bulanan dan pelepasan dibuat saat posting."
        actions={
          canManage ? (
            <Link href="/accounting/fixed-assets/new">
              <Button>Catat aset tetap</Button>
            </Link>
          ) : undefined
        }
      />
      <Card className="mb-4 flex flex-col gap-1" data-testid="fixed-asset-settings">
        <p className="text-base font-medium text-neutral-900">Pengaturan</p>
        {groups.map((group) => (
          <p key={group.code} className="text-sm text-neutral-700">
            {group.label}: {group.usefulLifeMonths} bulan
          </p>
        ))}
        <p className="text-sm text-neutral-700">Batas kapitalisasi: {formatRupiah(threshold)}</p>
        {canManage && (
          <Link href="/accounting/fixed-assets/settings" className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
            Ubah pengaturan
          </Link>
        )}
      </Card>
      <FixedAssetList rows={rows} />
    </>
  );
}
