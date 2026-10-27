import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Button, PageHeader } from "@ammari/ui";
import { SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { requireAnyPermission } from "@/lib/auth/require-any-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { getRole } from "@/lib/staff/queries";
import { PermissionMatrix } from "../../_components/permission-matrix";
import { RoleEditor } from "../../_components/role-editor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One role's permission matrix (docs/plans/roles-staff.md §4.4). Readable with staff.manage or
 * roles.manage; editable only by a super_admin with roles.manage, and never for the super_admin
 * role itself. */
export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAnyPermission(["staff.manage", "roles.manage"]);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const role = await getRole(id);
  if (!role) notFound();

  const isSuperAdminRole = role.key === SUPER_ADMIN_ROLE_KEY;
  const canEdit = session.permissionKeys.includes("roles.manage") && session.role.key === SUPER_ADMIN_ROLE_KEY && !isSuperAdminRole;
  const crumbs = [...rootCrumbs("/roles-staff"), { label: "Peran", href: "/roles-staff?tab=peran" }, { label: role.name }];

  return (
    <>
      <Breadcrumb items={crumbs} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title={role.name} description={role.description ?? undefined} />
        <div className="flex flex-wrap items-center gap-2">
          {role.isSystem && <Badge variant="neutral">Sistem</Badge>}
          <Badge variant="neutral">{role.activeStaffCount} staf aktif</Badge>
        </div>
      </div>

      {canEdit ? (
        <div className="flex flex-col gap-4">
          <div>
            <Link href={`/roles-staff/roles/new?copyFrom=${role.id}`}>
              <Button variant="secondary">Salin jadi peran baru</Button>
            </Link>
          </div>
          <RoleEditor
            mode="edit"
            roleId={role.id}
            activeStaffCount={role.activeStaffCount}
            initialValues={{ name: role.name, description: role.description ?? "", permissionKeys: role.permissionKeys }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-base text-neutral-600" data-testid="role-read-only">
            {isSuperAdminRole ? "Super Admin selalu punya semua izin." : "Hanya Super Admin yang bisa mengubah peran dan izinnya."}
          </p>
          <PermissionMatrix granted={new Set(role.permissionKeys)} />
        </div>
      )}
    </>
  );
}
