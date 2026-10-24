import type { PermissionKey } from "@ammari/db/rbac";

/** Who may see and change "Target penjualan" on /settings (owner decision, 2026-10-24): a setting
 * (settings.manage) that is also a revenue figure (finance.view_profit, D9). Both, always: the
 * section, its amount and its server action. */
export const SALES_GOAL_PERMISSIONS = ["settings.manage", "finance.view_profit"] as const satisfies readonly PermissionKey[];

export function canManageSalesGoal(permissionKeys: readonly string[]): boolean {
  return SALES_GOAL_PERMISSIONS.every((key) => permissionKeys.includes(key));
}
