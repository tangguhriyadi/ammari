import { describe, expect, test } from "vitest";
import { PERMISSIONS } from "@ammari/db/rbac";
import {
  PERMISSION_AREAS,
  PERMISSION_LABELS,
  SUPER_ADMIN_ONLY_PERMISSION_KEYS,
  permissionAreaGroups,
  sortPermissionKeys,
} from "./permission-labels";

// docs/plans/roles-staff.md §10 test 11. PermissionKey is a plain string type, so a key added to
// the catalog without a label can only be caught here.
describe("permission labels", () => {
  test("every catalog key has an Indonesian label in a known area, and nothing extra", () => {
    const catalog = PERMISSIONS.map((permission) => permission.key).sort();
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual(catalog);
    for (const label of Object.values(PERMISSION_LABELS)) {
      expect(PERMISSION_AREAS).toContain(label.area);
      expect(label.label.trim()).not.toBe("");
      // UI text rule: no em dash.
      expect(label.label).not.toContain("—");
    }
  });

  test("the sensitive set is exactly money, staff and access", () => {
    const sensitive = Object.entries(PERMISSION_LABELS)
      .filter(([, label]) => label.sensitive)
      .map(([key]) => key)
      .sort();
    expect(sensitive).toEqual(["audit_log.view", "finance.view_profit", "roles.manage", "staff.manage", "supplier_payments.manage"]);
    for (const key of sensitive) expect(PERMISSION_LABELS[key]!.warning).toBeTruthy();
  });

  test("roles.manage and audit_log.view are the super_admin-only keys", () => {
    expect([...SUPER_ADMIN_ONLY_PERMISSION_KEYS].sort()).toEqual(["audit_log.view", "roles.manage"]);
  });

  test("area groups cover every key once, in area order", () => {
    const groups = permissionAreaGroups();
    expect(groups.flatMap((group) => group.keys).sort()).toEqual(PERMISSIONS.map((permission) => permission.key).sort());
    const areaOrder = groups.map((group) => PERMISSION_AREAS.indexOf(group.area));
    expect([...areaOrder].sort((a, b) => a - b)).toEqual(areaOrder);
  });

  test("sortPermissionKeys follows the catalog order and drops duplicates", () => {
    expect(sortPermissionKeys(["staff.manage", "overview.view", "staff.manage", "orders.view"])).toEqual([
      "overview.view",
      "orders.view",
      "staff.manage",
    ]);
  });
});
