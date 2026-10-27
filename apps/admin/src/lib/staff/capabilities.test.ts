import { describe, expect, test } from "vitest";
import { ownerDefaultPermissionKeys, PREDEFINED_ROLES, superAdminDefaultPermissionKeys } from "@ammari/db/rbac";
import {
  canAssignRole,
  EMAIL_LOCKED,
  SELF_REFUSED,
  staffCapabilities,
  SUBSET_REFUSED,
  SUPER_ADMIN_ONLY_REFUSED,
  type CapabilityTarget,
  type CapabilityViewer,
} from "./capabilities";
import { matchesStatusFilter, staffStatus } from "./status";

const superAdmin: CapabilityViewer = { staffUserId: "sa", roleKey: "super_admin", permissionKeys: superAdminDefaultPermissionKeys() };
const owner: CapabilityViewer = { staffUserId: "ow", roleKey: "owner", permissionKeys: ownerDefaultPermissionKeys() };
const packing = PREDEFINED_ROLES.find((role) => role.key === "packing_warehouse")!;

function target(overrides: Partial<CapabilityTarget> = {}): CapabilityTarget {
  return {
    id: "t1",
    roleKey: packing.key,
    rolePermissionKeys: packing.permissionKeys,
    isActive: true,
    lastLoginAt: null,
    hasAuthUser: false,
    isLastProtectedHolder: false,
    ...overrides,
  };
}

describe("staffCapabilities (mirrors lib/staff/mutations.ts guard rails)", () => {
  test("own account: nothing", () => {
    const caps = staffCapabilities(superAdmin, target({ id: "sa", roleKey: "super_admin", rolePermissionKeys: superAdmin.permissionKeys }));
    expect(caps.manage).toBe(SELF_REFUSED);
    expect(Object.values(caps).every((reason) => reason !== null)).toBe(true);
  });

  test("the owner never manages a super_admin, nor anyone whose role is wider than hers", () => {
    expect(staffCapabilities(owner, target({ roleKey: "super_admin", rolePermissionKeys: superAdmin.permissionKeys })).manage).toBe(
      SUPER_ADMIN_ONLY_REFUSED,
    );
    expect(staffCapabilities(owner, target({ roleKey: "custom_x", rolePermissionKeys: ["audit_log.view"] })).manage).toBe(SUBSET_REFUSED);
  });

  test("the owner manages a pending packing invite: email editable, renew offered", () => {
    const caps = staffCapabilities(owner, target());
    expect(caps).toMatchObject({ manage: null, editName: null, editEmail: null, changeRole: null, deactivate: null, renewInvite: null });
    expect(caps.reactivate).not.toBeNull();
  });

  test("after the first login the email is locked and renew is not offered", () => {
    const caps = staffCapabilities(owner, target({ lastLoginAt: new Date(), hasAuthUser: true }));
    expect(caps.editEmail).toBe(EMAIL_LOCKED);
    expect(caps.renewInvite).toMatch(/sudah pernah masuk/);
  });

  test("the last active super_admin can't be deactivated or re-roled, but can be renamed", () => {
    const caps = staffCapabilities(
      superAdmin,
      target({ roleKey: "super_admin", rolePermissionKeys: superAdmin.permissionKeys, isLastProtectedHolder: true, lastLoginAt: new Date() }),
    );
    expect(caps.editName).toBeNull();
    expect(caps.deactivate).toMatch(/Super Admin aktif terakhir/);
    expect(caps.changeRole).toMatch(/Super Admin aktif terakhir/);
  });

  test("a deactivated person: reactivate only, and renew waits for reactivation", () => {
    const caps = staffCapabilities(owner, target({ isActive: false }));
    expect(caps.reactivate).toBeNull();
    expect(caps.deactivate).not.toBeNull();
    expect(caps.renewInvite).toMatch(/Aktifkan kembali/);
  });
});

describe("canAssignRole", () => {
  test("super_admin only by a super_admin; otherwise the subset rule", () => {
    const superAdminRole = { key: "super_admin", permissionKeys: superAdmin.permissionKeys };
    expect(canAssignRole(superAdminRole, superAdmin)).toBe(true);
    expect(canAssignRole(superAdminRole, owner)).toBe(false);
    expect(canAssignRole({ key: "owner", permissionKeys: owner.permissionKeys }, owner)).toBe(true);
    for (const role of PREDEFINED_ROLES) expect(canAssignRole(role, owner)).toBe(true);
    expect(canAssignRole({ key: "custom", permissionKeys: ["roles.manage"] }, owner)).toBe(false);
  });
});

describe("staffStatus", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  test("derives the four states", () => {
    expect(staffStatus({ isActive: false, lastLoginAt: now, inviteExpiresAt: null }, now)).toBe("inactive");
    expect(staffStatus({ isActive: true, lastLoginAt: now, inviteExpiresAt: new Date(0) }, now)).toBe("active");
    expect(staffStatus({ isActive: true, lastLoginAt: null, inviteExpiresAt: new Date(now.getTime() + 1000) }, now)).toBe("invited");
    expect(staffStatus({ isActive: true, lastLoginAt: null, inviteExpiresAt: now }, now)).toBe("invite_expired");
    // Seed-style row: no expiry, never logged in.
    expect(staffStatus({ isActive: true, lastLoginAt: null, inviteExpiresAt: null }, now)).toBe("invited");
  });

  test("the Undangan chip includes expired invitations", () => {
    expect(matchesStatusFilter("invite_expired", "undangan")).toBe(true);
    expect(matchesStatusFilter("invited", "aktif")).toBe(false);
    expect(matchesStatusFilter("inactive", undefined)).toBe(true);
  });
});
