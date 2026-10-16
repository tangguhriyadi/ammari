import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getStoreSettings } from "@/lib/content/store-settings";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { StoreSettingsForm } from "./_components/store-settings-form";

export default async function ContentSettingsPage() {
  await requirePermission("content.manage");
  const settings = await getStoreSettings();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/content/settings")} />
      <PageHeader
        title="Pengaturan Toko"
        description="Nomor WhatsApp, email, dan alamat yang ditampilkan di footer dan halaman produk toko online. Simpan langsung tayang."
      />
      <StoreSettingsForm
        initialValues={{
          whatsappNumber: settings.whatsappNumber ?? "",
          supportEmail: settings.supportEmail ?? "",
          businessAddress: settings.businessAddress ?? "",
          returnPolicySummary: settings.returnPolicySummary ?? "",
        }}
      />
    </>
  );
}
