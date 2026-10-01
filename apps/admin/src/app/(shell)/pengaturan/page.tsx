import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PengaturanPage() {
  await requirePermission("settings.manage");
  return <ComingSoonPage title="Pengaturan" description="Target, asumsi biaya, dan pengaturan lainnya." />;
}
