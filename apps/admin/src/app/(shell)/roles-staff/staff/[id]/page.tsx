import { notFound } from "next/navigation";
import { Breadcrumb, Card, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { adminBaseUrl } from "@/lib/auth/staff";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { STAFF_AUDIT_ACTIONS } from "@/lib/staff/mutations";
import { assignableRoles, getStaffDetail, listRoles, listStaffHistory } from "@/lib/staff/queries";
import { StaffStatusBadge } from "../../_components/staff-list";
import { StaffActions } from "../../_components/staff-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HISTORY_LABELS: Record<string, string> = {
  [STAFF_AUDIT_ACTIONS.invite]: "Diundang",
  [STAFF_AUDIT_ACTIONS.inviteRenew]: "Undangan dikirim ulang",
  [STAFF_AUDIT_ACTIONS.inviteEmailFailed]: "Email undangan gagal terkirim",
  [STAFF_AUDIT_ACTIONS.update]: "Nama/email diubah",
  [STAFF_AUDIT_ACTIONS.roleChange]: "Peran diganti",
  [STAFF_AUDIT_ACTIONS.deactivate]: "Dinonaktifkan",
  [STAFF_AUDIT_ACTIONS.reactivate]: "Diaktifkan kembali",
  [STAFF_AUDIT_ACTIONS.sessionsRevoke]: "Semua sesi diakhiri",
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="break-words text-base text-neutral-900">{value}</dd>
    </div>
  );
}

/** One staff member (docs/plans/roles-staff.md §4.3). Every action is also refused on the server
 * when not allowed; the page only hides or explains it. */
export default async function StaffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("staff.manage");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const viewer = { staffUserId: session.staffUser.id, roleKey: session.role.key, permissionKeys: session.permissionKeys };
  const detail = await getStaffDetail(id, viewer);
  if (!detail) notFound();
  const canViewHistory = session.permissionKeys.includes("audit_log.view");
  const [roles, history] = await Promise.all([listRoles(), canViewHistory ? listStaffHistory(detail.id) : Promise.resolve([])]);
  const isSelf = detail.id === session.staffUser.id;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/roles-staff"), { label: detail.name }]} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title={isSelf ? `${detail.name} (Anda)` : detail.name} description={detail.email} />
        <StaffStatusBadge status={detail.status} />
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DetailRow label="Peran" value={detail.roleName} />
            <DetailRow label="Terakhir masuk" value={detail.lastLoginAt ? formatDateTime(detail.lastLoginAt) : "Belum pernah masuk"} />
            {detail.invitedAt && (
              <DetailRow
                label="Diundang"
                value={`${formatDateTime(detail.invitedAt)}${detail.invitedByName ? ` oleh ${detail.invitedByName}` : ""}`}
              />
            )}
            {!detail.lastLoginAt && detail.inviteExpiresAt && (
              <DetailRow label="Undangan berlaku sampai" value={formatDateTime(detail.inviteExpiresAt)} />
            )}
            {detail.deactivatedAt && !detail.isActive && <DetailRow label="Dinonaktifkan" value={formatDateTime(detail.deactivatedAt)} />}
            <DetailRow label="Sesi aktif" value={String(detail.activeSessionCount)} />
          </dl>
        </Card>

        <StaffActions
          // Remounted when the saved data changes (router.refresh after a save, or someone else's
          // edit), so the form never keeps showing stale or un-normalised values.
          key={`${detail.name}|${detail.email}|${detail.roleId}|${detail.isActive}`}
          staff={{
            id: detail.id,
            name: detail.name,
            email: detail.email,
            roleId: detail.roleId,
            roleName: detail.roleName,
            isActive: detail.isActive,
            status: detail.status,
            activeSessionCount: detail.activeSessionCount,
          }}
          capabilities={detail.capabilities}
          roles={assignableRoles(roles, viewer)}
          adminUrl={adminBaseUrl}
        />

        {canViewHistory && (
          <section aria-labelledby="staff-history-heading" className="flex flex-col gap-2">
            <h2 id="staff-history-heading" className="text-lg font-semibold text-neutral-900">
              Riwayat
            </h2>
            {history.length === 0 ? (
              <p className="text-base text-neutral-600">Belum ada riwayat.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                {history.map((row) => (
                  <li key={row.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:justify-between">
                    <span className="text-base text-neutral-900">{HISTORY_LABELS[row.action] ?? row.action}</span>
                    <span className="text-sm text-neutral-600">
                      {formatDateTime(row.createdAt)}
                      {row.actorName ? ` oleh ${row.actorName}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}
