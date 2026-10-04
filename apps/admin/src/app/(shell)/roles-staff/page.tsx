import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PeranStafPage() {
  await requireAnyPermission(["staff.manage", "roles.manage"]);
  return <ComingSoonPage title="Peran & Staf" description="Kelola akun staf, peran, dan izinnya." />;
}
