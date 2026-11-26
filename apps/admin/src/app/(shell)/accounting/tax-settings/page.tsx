import Link from "next/link";
import { Breadcrumb, Button, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { listTaxSettings } from "@/lib/accounting/tax-settings";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TaxSettingList } from "./_components/tax-setting-list";

// Pengaturan pajak (D-20, Session 3): the PPh final settings the monthly accrual (Session 11)
// reads. accounting.view reads; accounting.manage adds and edits (audited).
export default async function TaxSettingsPage() {
  const session = await requirePermission("accounting.view");
  const canManage = session.permissionKeys.includes("accounting.manage");
  const rows = await listTaxSettings();
  const today = jakartaDate();
  const current = rows.find((row) => row.effectiveFrom <= today) ?? null;
  const expired = current?.rateValidUntil != null && current.rateValidUntil < today;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/tax-settings")} />
      <PageHeader
        title="Pengaturan Pajak"
        description="PPh final: tarif, batas omzet bebas pajak per tahun dan tanggal akhir berlakunya tarif. Pengaturan yang berlaku untuk suatu bulan adalah yang mulai berlaku paling akhir sebelum atau pada bulan itu. Perubahan hanya berlaku ke depan."
        actions={
          canManage ? (
            <Link href="/accounting/tax-settings/new">
              <Button>Tambah pengaturan</Button>
            </Link>
          ) : undefined
        }
      />
      {expired && (
        <p role="status" className="mb-4 rounded-lg border border-warning-700/30 bg-warning-50 p-4 text-base text-warning-700">
          Tarif PPh final berakhir, periksa pengaturan pajak. Selama belum diperbarui, PPh final bulanan tidak diusulkan.
        </p>
      )}
      <TaxSettingList rows={rows} canManage={canManage} />
    </>
  );
}
