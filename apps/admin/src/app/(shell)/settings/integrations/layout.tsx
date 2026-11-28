import { Suspense, type ReactNode } from "react";
import { getStaffSession } from "@/lib/auth/staff-session";
import { visibleIntegrationTabs } from "@/lib/integrations/tabs";
import { IntegrationChrome } from "./_components/integration-chrome";

// Filtering the tabs is cosmetic: every page below checks its own permission.
async function SessionChrome() {
  const session = await getStaffSession();
  return <IntegrationChrome tabs={visibleIntegrationTabs(session?.permissionKeys ?? [])} />;
}

// The layout itself awaits nothing, so entering Integrasi shows the loading.tsx below it rather
// than the Pengaturan form skeleton. It stays mounted while tabs are switched.
export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense>
        <SessionChrome />
      </Suspense>
      {children}
    </>
  );
}
