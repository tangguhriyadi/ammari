import Link from "next/link";
import { Badge, Button, Card, CardList, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import type { RoleRow } from "@/lib/staff/queries";

function SystemBadge({ role }: { role: RoleRow }) {
  return role.isSystem ? <Badge variant="neutral">Sistem</Badge> : null;
}

function ProfitBadge({ role }: { role: RoleRow }) {
  return role.permissionKeys.includes("finance.view_profit") ? <Badge variant="warning">Bisa lihat laba</Badge> : null;
}

/** The Peran tab (docs/plans/roles-staff.md §4.4). Each role opens its permission matrix. Roles
 * are never deleted (owner answer 7). */
export function RoleList({ roles, canManageRoles }: { roles: RoleRow[]; canManageRoles: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base text-neutral-600">
          {canManageRoles ? "Buka peran untuk melihat atau mengubah izinnya." : "Buka peran untuk melihat izinnya. Hanya Super Admin yang bisa mengubah peran."}
        </p>
        {canManageRoles && (
          <Link href="/roles-staff/roles/new">
            <Button>Buat peran</Button>
          </Link>
        )}
      </div>

      <CardList>
        {roles.map((role) => (
          <li key={role.id} data-testid="role-row">
            <Link href={`/roles-staff/roles/${role.id}`} className="block">
              <Card className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-medium text-neutral-900">{role.name}</p>
                  <SystemBadge role={role} />
                  <ProfitBadge role={role} />
                </div>
                {role.description && <p className="text-sm text-neutral-600">{role.description}</p>}
                <p className="text-sm text-neutral-700">
                  {role.activeStaffCount} staf aktif · {role.permissionKeys.length} izin
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Peran</Th>
          <Th>Deskripsi</Th>
          <Th>Staf aktif</Th>
          <Th>Izin</Th>
        </TableHead>
        <tbody>
          {roles.map((role) => (
            <Tr key={role.id} data-testid="role-row">
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/roles-staff/roles/${role.id}`} className="font-medium text-brand hover:underline">
                    {role.name}
                  </Link>
                  <SystemBadge role={role} />
                  <ProfitBadge role={role} />
                </div>
              </Td>
              <Td className="text-neutral-700">{role.description ?? "-"}</Td>
              <Td className="text-neutral-700">{role.activeStaffCount}</Td>
              <Td className="text-neutral-700">{role.permissionKeys.length}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </div>
  );
}
