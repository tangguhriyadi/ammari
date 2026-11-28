import { Breadcrumb, PageHeader, Tabs, type BreadcrumbItem } from "@ammari/ui";
import type { StaffSessionData } from "@ammari/auth/staff";
import { integrationCrumbs } from "@/lib/integrations/breadcrumb";
import { visibleIntegrationTabs, type IntegrationTab } from "@/lib/integrations/tabs";

/** The top of every Integrasi tab page: breadcrumb, title and the tabs this session may see. */
export function IntegrationHeader({ session, tab, description, crumb }: { session: StaffSessionData; tab: IntegrationTab; description: string; crumb?: BreadcrumbItem }) {
  const items = visibleIntegrationTabs(session.permissionKeys).map((item) => ({ label: item.label, href: item.href, isActive: item.href === tab.href }));
  return (
    <>
      <Breadcrumb items={crumb ? [...integrationCrumbs(tab), crumb] : integrationCrumbs(tab)} />
      <PageHeader title="Integrasi" description={description} />
      <div className="mb-4">
        <Tabs items={items} aria-label="Tab integrasi" />
      </div>
    </>
  );
}
