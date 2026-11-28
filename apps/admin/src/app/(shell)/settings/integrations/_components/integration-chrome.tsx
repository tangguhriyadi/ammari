"use client";

import { usePathname } from "next/navigation";
import { Breadcrumb, PageHeader, Tabs } from "@ammari/ui";
import { integrationChrome } from "@/lib/integrations/chrome";
import type { IntegrationTab } from "@/lib/integrations/tabs";

const TAB_LOGOS: Record<string, string> = {
  "TikTok Shop": "/logos/tiktok.png",
  Shopee: "/logos/shopee.png",
};

/** The top of every Integrasi tab page: breadcrumb, title and the tabs this session may see. It
 * lives in the layout and follows the pathname, so switching tabs never reloads it. */
export function IntegrationChrome({ tabs }: { tabs: IntegrationTab[] }) {
  const chrome = integrationChrome(usePathname());
  if (!chrome) return null;
  const items = tabs.map((tab) => ({ label: tab.label, href: tab.href, iconSrc: TAB_LOGOS[tab.label], isActive: tab.href === chrome.tab?.href }));
  return (
    <>
      <Breadcrumb items={chrome.crumbs} />
      <PageHeader title="Integrasi" description={chrome.description} />
      <div className="mb-4">
        <Tabs items={items} aria-label="Tab integrasi" />
      </div>
    </>
  );
}
