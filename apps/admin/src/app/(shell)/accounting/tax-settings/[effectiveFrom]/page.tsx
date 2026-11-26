import { notFound } from "next/navigation";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { formatDay } from "@/lib/accounting/format";
import { getTaxSetting } from "@/lib/accounting/tax-settings";
import { formatBpsAsPercent } from "@/lib/accounting/tax-settings-input";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TaxSettingForm } from "../_components/tax-setting-form";

// Edit one PPh final setting (D-20): everything but its start month. Audited.
export default async function EditTaxSettingPage({ params }: { params: Promise<{ effectiveFrom: string }> }) {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const { effectiveFrom } = await params;
  const row = await getTaxSetting(effectiveFrom);
  if (!row) notFound();
  const monthLabel = formatDay(row.effectiveFrom).replace(/^1 /, "");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/tax-settings"), { label: monthLabel }]} />
      <PageHeader title={`Pengaturan Pajak ${monthLabel}`} description="Perubahan dicatat di Log Aktivitas dan hanya berlaku untuk bulan yang belum dihitung PPh finalnya." />
      <TaxSettingForm
        mode="edit"
        effectiveFrom={row.effectiveFrom}
        monthLabel={monthLabel}
        initialValues={{
          taxpayerType: row.taxpayerType,
          taxpayerLabel: row.taxpayerLabel,
          npwpRegisteredYear: row.npwpRegisteredYear ? String(row.npwpRegisteredYear) : "",
          ratePercent: formatBpsAsPercent(row.rateBps),
          annualExemptionAmount: String(row.annualExemptionAmount),
          rateValidUntil: row.rateValidUntil ?? "",
          note: row.note ?? "",
        }}
      />
    </>
  );
}
