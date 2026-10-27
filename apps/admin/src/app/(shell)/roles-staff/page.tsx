import { Breadcrumb, PageHeader, Tabs } from "@ammari/ui";
import { SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { adminBaseUrl } from "@/lib/auth/staff";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { assignableRoles, listRoles, listStaff } from "@/lib/staff/queries";
import { isStaffStatusFilter, matchesStatusFilter } from "@/lib/staff/status";
import { InviteStaff } from "./_components/invite-staff";
import { RoleList } from "./_components/role-list";
import { StaffList } from "./_components/staff-list";

// docs/plans/roles-staff.md §4: two tabs. Staf needs staff.manage; Peran is readable with
// staff.manage (to see what a role grants before assigning it) and editable with roles.manage
// (super_admin only). A viewer with only roles.manage lands on Peran.
const STATUS_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Aktif", value: "aktif" },
  { label: "Undangan", value: "undangan" },
  { label: "Nonaktif", value: "nonaktif" },
] as const;

export default async function RolesStaffPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  const session = await requireAnyPermission(["staff.manage", "roles.manage"]);
  const { tab: rawTab, status: rawStatus } = await searchParams;
  const canManageStaff = session.permissionKeys.includes("staff.manage");
  // Same rule as lib/staff/role-mutations.ts: roles.manage AND the super_admin role (answer 1).
  const canManageRoles = session.permissionKeys.includes("roles.manage") && session.role.key === SUPER_ADMIN_ROLE_KEY;
  const tab = rawTab === "peran" || !canManageStaff ? "peran" : "staf";
  const statusFilter = isStaffStatusFilter(rawStatus) ? rawStatus : undefined;
  const viewer = { staffUserId: session.staffUser.id, roleKey: session.role.key, permissionKeys: session.permissionKeys };

  const [roles, staff] = await Promise.all([listRoles(), tab === "staf" ? listStaff() : Promise.resolve([])]);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/roles-staff")} />
      <PageHeader
        title="Peran & Staf"
        description="Siapa saja yang bisa masuk ke admin, dan apa yang boleh mereka lakukan."
      />
      <div className="flex flex-col gap-4">
        {canManageStaff && (
          <Tabs
            aria-label="Bagian Peran & Staf"
            items={[
              { label: "Staf", href: "/roles-staff", isActive: tab === "staf" },
              { label: "Peran", href: "/roles-staff?tab=peran", isActive: tab === "peran" },
            ]}
          />
        )}
        {tab === "staf" ? (
          <>
            <InviteStaff roles={assignableRoles(roles, viewer)} adminUrl={adminBaseUrl} />
            <Tabs
              aria-label="Filter status staf"
              items={STATUS_FILTER_OPTIONS.map((option) => ({
                label: option.label,
                href: option.value ? `/roles-staff?status=${option.value}` : "/roles-staff",
                isActive: option.value === statusFilter,
              }))}
            />
            <StaffList rows={staff.filter((row) => matchesStatusFilter(row.status, statusFilter))} viewerId={session.staffUser.id} filtered={Boolean(statusFilter)} />
          </>
        ) : (
          <RoleList roles={roles} canManageRoles={canManageRoles} />
        )}
      </div>
    </>
  );
}
