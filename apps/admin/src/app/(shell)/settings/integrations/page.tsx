import { forbidden, redirect } from "next/navigation";
import { requireAnyPermission } from "@/lib/auth/require-permission";
import { INTEGRATION_PERMISSIONS, visibleIntegrationTabs } from "@/lib/integrations/tabs";

// Administrasi > Integrasi has no content of its own: it opens the first tab this session may see.
export default async function IntegrationsPage() {
  const session = await requireAnyPermission(INTEGRATION_PERMISSIONS);
  const [first] = visibleIntegrationTabs(session.permissionKeys);
  if (!first) forbidden();
  redirect(first.href);
}
