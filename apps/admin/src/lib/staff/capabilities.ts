import { SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";

// What the staff detail page offers, mirroring the guard rails lib/staff/mutations.ts enforces
// under the lock (docs/plans/roles-staff.md §5). This is UI only: an action shown here can still
// be refused by the server (e.g. a concurrent change), and an action hidden here is refused there
// too. Pure, so the rules are unit-tested without a database.

export const SELF_REFUSED = "Anda tidak bisa mengubah akun Anda sendiri di sini.";
export const SUPER_ADMIN_ONLY_REFUSED = "Hanya Super Admin yang bisa mengubah akun Super Admin.";
export const SUBSET_REFUSED = "Peran staf ini punya izin yang tidak Anda miliki, jadi Anda tidak bisa mengubahnya.";
export const EMAIL_LOCKED = "Email tidak bisa diubah setelah staf pernah masuk. Nonaktifkan akun ini lalu undang email baru.";

const LAST_HOLDER_MESSAGES: Record<string, string> = {
  super_admin: "Ini Super Admin aktif terakhir, jadi tidak bisa dinonaktifkan atau diganti perannya.",
  owner: "Ini Owner aktif terakhir, jadi tidak bisa dinonaktifkan atau diganti perannya.",
};

export interface CapabilityViewer {
  staffUserId: string;
  roleKey: string;
  permissionKeys: readonly string[];
}

export interface CapabilityTarget {
  id: string;
  roleKey: string;
  rolePermissionKeys: readonly string[];
  isActive: boolean;
  lastLoginAt: Date | null;
  /** Has a Better Auth user (logged in at least once, by any method). */
  hasAuthUser: boolean;
  /** The only active, admissible holder of super_admin/owner (same rule as the mutation). */
  isLastProtectedHolder: boolean;
}

/** `null` = allowed; a string = the Indonesian reason it isn't. */
export interface StaffCapabilities {
  /** Why nothing at all can be changed (self, super_admin, subset), or null. */
  manage: string | null;
  editName: string | null;
  editEmail: string | null;
  changeRole: string | null;
  deactivate: string | null;
  reactivate: string | null;
  revokeSessions: string | null;
  renewInvite: string | null;
}

export function isRoleWithin(rolePermissionKeys: readonly string[], actorPermissionKeys: readonly string[]): boolean {
  const held = new Set(actorPermissionKeys);
  return rolePermissionKeys.every((key) => held.has(key));
}

/** The two rules for assigning a role (invite or role change): super_admin only by a super_admin,
 * and only roles whose permissions the viewer holds too. */
export function canAssignRole(role: { key: string; permissionKeys: readonly string[] }, viewer: CapabilityViewer): boolean {
  if (role.key === SUPER_ADMIN_ROLE_KEY && viewer.roleKey !== SUPER_ADMIN_ROLE_KEY) return false;
  return isRoleWithin(role.permissionKeys, viewer.permissionKeys);
}

export function staffCapabilities(viewer: CapabilityViewer, target: CapabilityTarget): StaffCapabilities {
  let manage: string | null = null;
  if (target.id === viewer.staffUserId) manage = SELF_REFUSED;
  else if (target.roleKey === SUPER_ADMIN_ROLE_KEY && viewer.roleKey !== SUPER_ADMIN_ROLE_KEY) manage = SUPER_ADMIN_ONLY_REFUSED;
  else if (!isRoleWithin(target.rolePermissionKeys, viewer.permissionKeys)) manage = SUBSET_REFUSED;

  const lastHolder = target.isActive && target.isLastProtectedHolder ? (LAST_HOLDER_MESSAGES[target.roleKey] ?? null) : null;
  const neverLoggedIn = !target.lastLoginAt && !target.hasAuthUser;

  return {
    manage,
    editName: manage,
    editEmail: manage ?? (neverLoggedIn ? null : EMAIL_LOCKED),
    changeRole: manage ?? lastHolder,
    deactivate: manage ?? (target.isActive ? lastHolder : "Akun ini sudah nonaktif."),
    reactivate: manage ?? (target.isActive ? "Akun ini sudah aktif." : null),
    revokeSessions: manage,
    renewInvite:
      manage ??
      (target.lastLoginAt ? "Staf ini sudah pernah masuk, tidak perlu undangan." : target.isActive ? null : "Aktifkan kembali akun ini dulu."),
  };
}
