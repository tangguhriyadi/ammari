import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { listTaxSettings } from "@/lib/accounting/tax-settings";
import { formatBpsAsPercent } from "@/lib/accounting/tax-settings-input";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TaxSettingForm } from "../_components/tax-setting-form";

// A new effective row (D-20), prefilled from the latest one (e.g. a new rate from some month).
export default async function NewTaxSettingPage() {
  await requireAllPermissions(["accounting.view", "accounting.manage"]);
  const [latest] = await listTaxSettings();
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/accounting/tax-settings"), { label: "Tambah pengaturan" }]} />
      <PageHeader title="Tambah Pengaturan Pajak" description="Dipakai mulai bulan yang dipilih sampai ada pengaturan yang lebih baru." />
      <TaxSettingForm
        mode="create"
        initialValues={{
          taxpayerType: latest?.taxpayerType ?? "individual",
          taxpayerLabel: latest?.taxpayerLabel ?? "",
          npwpRegisteredYear: latest?.npwpRegisteredYear ? String(latest.npwpRegisteredYear) : "",
          ratePercent: latest ? formatBpsAsPercent(latest.rateBps) : "",
          annualExemptionAmount: latest ? String(latest.annualExemptionAmount) : "",
          rateValidUntil: "",
          note: "",
        }}
      />
    </>
  );
}
