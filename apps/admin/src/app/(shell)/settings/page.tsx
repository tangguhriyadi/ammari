import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PengaturanPage() {
  await requirePermission("settings.manage");
  return <ComingSoonPage href="/settings" title="Pengaturan" description="Target, asumsi biaya, dan pengaturan lainnya." />;
}
