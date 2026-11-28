import type { PermissionKey } from "@ammari/db/rbac";

// The tabs of Administrasi > Integrasi, one URL each. Filtering them is cosmetic: every tab's page
// calls requirePermission with its own key.

export const INTEGRATIONS_PATH = "/settings/integrations";

export interface IntegrationTab {
  label: string;
  href: string;
  permissionKey: PermissionKey;
}

export const TIKTOK_TAB: IntegrationTab = { label: "TikTok Shop", href: `${INTEGRATIONS_PATH}/tiktok`, permissionKey: "integrations.manage" };
export const SHOPEE_TAB: IntegrationTab = { label: "Shopee", href: `${INTEGRATIONS_PATH}/shopee`, permissionKey: "orders.import" };

/** In display order: the first one a session may see is where /settings/integrations lands. */
export const INTEGRATION_TABS: readonly IntegrationTab[] = [TIKTOK_TAB, SHOPEE_TAB];

export const INTEGRATION_PERMISSIONS: readonly PermissionKey[] = INTEGRATION_TABS.map((tab) => tab.permissionKey);

export function visibleIntegrationTabs(permissionKeys: readonly PermissionKey[]): IntegrationTab[] {
  return INTEGRATION_TABS.filter((tab) => permissionKeys.includes(tab.permissionKey));
}
