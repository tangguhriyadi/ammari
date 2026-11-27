import { notFound } from "next/navigation";
import { Breadcrumb, Card, PageHeader } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { formatDay } from "@/lib/accounting/format";
import { getFixedAsset, getFixedAssetFormChoices, listFixedAssets } from "@/lib/accounting/fixed-assets";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { DisposeFixedAssetButton, VoidFixedAssetButton } from "../_components/fixed-asset-actions";
import { FixedAssetForm } from "../_components/fixed-asset-form";
import { FixedAssetStatusBadge } from "../_components/fixed-asset-list";

// One fixed asset (D-19): its figures, and for accounting.manage the edit form (while not disposed or
// voided), "Lepas aset" and "Batalkan aset". Journals follow on the next posting run.
export default async function FixedAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const { id } = await params;
  const asset = await getFixedAsset(id);
  if (!asset) notFound();
  const [rows, choices] = await Promise.all([listFixedAssets(undefined, undefined, asset.id), canManage ? getFixedAssetFormChoices() : Promise.resolve(null)]);
  const row = rows.find((entry) => entry.id === asset.id);
  if (!row) notFound();
  const editable = canManage && row.status !== "voided" && row.status !== "disposed";

  const facts: [string, string][] = [
    ["Kelompok", `${row.groupLabel} (${asset.usefulLifeMonths} bulan)`],
    ["Tanggal perolehan", formatDay(asset.acquisitionDate)],
    ["Harga perolehan", formatRupiah(asset.cost)],
    ["Akun aset", `${asset.assetAccountCode} ${row.assetAccountName}`],
    ["Akun akumulasi penyusutan", asset.accumulatedAccountCode],
    ["Dibayar dari", asset.fundingAccountCode ?? "Sudah tercatat (saldo awal atau jurnal lain)"],
    ["Penyusutan per bulan", formatRupiah(row.monthlyAmount)],
    ["Akumulasi penyusutan s.d. bulan ini", formatRupiah(row.accumulated)],
    ["Nilai buku", formatRupiah(row.bookValue)],
  ];
  if (asset.disposedOn) facts.push(["Dilepas", `${formatDay(asset.disposedOn)}, hasil ${formatRupiah(asset.disposalProceeds ?? 0)}`]);
  if (asset.voidReason) facts.push(["Alasan dibatalkan", asset.voidReason]);
  if (asset.note) facts.push(["Catatan", asset.note]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/fixed-assets"), { label: asset.name }]} />
      <PageHeader title={asset.name} description="Perubahan dicatat di Log Aktivitas. Jurnalnya dihitung ulang pada posting berikutnya." />
      <Card className="mb-6 flex max-w-xl flex-col gap-2" data-testid="fixed-asset-detail">
        <div>
          <FixedAssetStatusBadge status={row.status} />
        </div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-neutral-600">{label}</dt>
              <dd className="text-neutral-900 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {canManage && row.status !== "voided" && choices && (
          <div className="flex flex-wrap gap-3 pt-2">
            {!asset.disposedOn && <DisposeFixedAssetButton id={asset.id} name={asset.name} cashAccounts={choices.cashAccounts} />}
            <VoidFixedAssetButton id={asset.id} name={asset.name} />
          </div>
        )}
      </Card>
      {editable && choices && (
        <>
          <h2 className="mb-3 text-lg font-medium text-neutral-900">Ubah aset</h2>
          <FixedAssetForm
            mode="edit"
            id={asset.id}
            choices={choices}
            initialValues={{
              name: asset.name,
              groupCode: asset.groupCode,
              acquisitionDate: asset.acquisitionDate,
              cost: String(asset.cost),
              assetAccountCode: asset.assetAccountCode,
              accumulatedAccountCode: asset.accumulatedAccountCode,
              fundingAccountCode: asset.fundingAccountCode ?? "",
              note: asset.note ?? "",
            }}
          />
        </>
      )}
    </>
  );
}
