import type { BadgeVariant } from "@ammari/ui";

// The staff status shown on the Staf tab (docs/plans/roles-staff.md §3). Derived, never stored:
// a staff_users row is the invitation, and the admission gate (@ammari/auth staff-data.ts)
// applies the same expiry rule. Client-safe.

export type StaffStatus = "active" | "invited" | "invite_expired" | "inactive";

export interface StaffStatusInput {
  isActive: boolean;
  lastLoginAt: Date | null;
  inviteExpiresAt: Date | null;
}

export function staffStatus(row: StaffStatusInput, now: Date = new Date()): StaffStatus {
  if (!row.isActive) return "inactive";
  // A row that never logged in and has no expiry is a seed-style account (or predates 0041):
  // admissible, so "Undangan" until the first login, never "kedaluwarsa".
  if (row.lastLoginAt) return "active";
  if (row.inviteExpiresAt && row.inviteExpiresAt.getTime() <= now.getTime()) return "invite_expired";
  return "invited";
}

export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = {
  active: "Aktif",
  invited: "Undangan",
  invite_expired: "Undangan kedaluwarsa",
  inactive: "Nonaktif",
};

/** Muted tones (CLAUDE.md visual identity): olive for Aktif, neutral for Undangan, brick for the
 * two states that need attention. */
export const STAFF_STATUS_BADGE: Record<StaffStatus, BadgeVariant> = {
  active: "success",
  invited: "neutral",
  invite_expired: "danger",
  inactive: "danger",
};

/** The Staf tab's filter chips. "Undangan" includes expired invitations. */
export const STAFF_STATUS_FILTERS = ["aktif", "undangan", "nonaktif"] as const;
export type StaffStatusFilter = (typeof STAFF_STATUS_FILTERS)[number];

export function isStaffStatusFilter(value: unknown): value is StaffStatusFilter {
  return typeof value === "string" && (STAFF_STATUS_FILTERS as readonly string[]).includes(value);
}

export function matchesStatusFilter(status: StaffStatus, filter: StaffStatusFilter | undefined): boolean {
  if (!filter) return true;
  if (filter === "aktif") return status === "active";
  if (filter === "undangan") return status === "invited" || status === "invite_expired";
  return status === "inactive";
}
