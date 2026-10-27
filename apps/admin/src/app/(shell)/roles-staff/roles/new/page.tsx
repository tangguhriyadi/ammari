import { forbidden } from "next/navigation";
import { Breadcrumb, PageHeader } from "@ammari/ui";
import { SUPER_ADMIN_ROLE_KEY } from "@ammari/db/rbac";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SUPER_ADMIN_ONLY_PERMISSION_KEYS } from "@/lib/staff/permission-labels";
import { getRole } from "@/lib/staff/queries";
import { RoleEditor } from "../../_components/role-editor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Buat peran" (docs/plans/roles-staff.md §4.4): blank, or "Salin dari peran ini" via
 * `?copyFrom=<role id>`. Super_admin only (owner answer 1). */
export default async function NewRolePage({ searchParams }: { searchParams: Promise<{ copyFrom?: string }> }) {
  const session = await requirePermission("roles.manage");
  if (session.role.key !== SUPER_ADMIN_ROLE_KEY) forbidden();
  const { copyFrom } = await searchParams;
  const source = copyFrom && UUID.test(copyFrom) ? await getRole(copyFrom) : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/roles-staff"), { label: "Peran", href: "/roles-staff?tab=peran" }, { label: "Buat peran" }]} />
      <PageHeader
        title="Buat peran"
        description={source ? `Izin disalin dari ${source.name}. Ubah nama dan izinnya sebelum menyimpan.` : "Beri nama, lalu pilih izinnya."}
      />
      <RoleEditor
        mode="create"
        copiedFromRoleId={source?.id ?? null}
        initialValues={{
          name: source ? `Salinan ${source.name}` : "",
          description: source?.description ?? "",
          // Copying super_admin (or a legacy role) must not carry keys no other role may hold.
          permissionKeys: source ? source.permissionKeys.filter((key) => !SUPER_ADMIN_ONLY_PERMISSION_KEYS.includes(key)) : [],
        }}
      />
    </>
  );
}
