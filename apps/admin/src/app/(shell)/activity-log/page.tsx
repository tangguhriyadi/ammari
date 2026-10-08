import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function LogAktivitasPage() {
  await requirePermission("audit_log.view");
  return <ComingSoonPage href="/activity-log" title="Log Aktivitas" description="Riwayat perubahan peran, staf, dan data sensitif." />;
}
