import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import type { StaffListRow } from "@/lib/staff/queries";
import { STAFF_STATUS_BADGE, STAFF_STATUS_LABELS, type StaffStatus } from "@/lib/staff/status";

export function StaffStatusBadge({ status }: { status: StaffStatus }) {
  return (
    <Badge variant={STAFF_STATUS_BADGE[status]} data-testid="staff-status">
      {STAFF_STATUS_LABELS[status]}
    </Badge>
  );
}

function lastLoginText(lastLoginAt: Date | null): string {
  return lastLoginAt ? formatDateTime(lastLoginAt) : "Belum pernah masuk";
}

/** The Staf tab (docs/plans/roles-staff.md §4.1): phone cards and a tablet/desktop table, both
 * linking to the person's page, where every action lives. */
export function StaffList({ rows, viewerId, filtered }: { rows: StaffListRow[]; viewerId: string; filtered: boolean }) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState title="Tidak ada staf" description="Tidak ada staf dengan status ini." />
    ) : (
      <EmptyState title="Belum ada staf" description="Undang staf supaya mereka bisa masuk ke admin." />
    );
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid="staff-row" data-email={row.email}>
            <Link href={`/roles-staff/staff/${row.id}`} className="block">
              <Card className="flex flex-col gap-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 break-words text-base font-medium text-neutral-900">
                    {row.name}
                    {row.id === viewerId && <span className="font-normal text-neutral-600"> (Anda)</span>}
                  </p>
                  <StaffStatusBadge status={row.status} />
                </div>
                <p className="break-all text-sm text-neutral-600">{row.email}</p>
                <p className="text-sm text-neutral-700">{row.roleName}</p>
                <p className="text-sm text-neutral-600">Terakhir masuk: {lastLoginText(row.lastLoginAt)}</p>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Email</Th>
          <Th>Peran</Th>
          <Th>Status</Th>
          <Th>Terakhir masuk</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid="staff-row" data-email={row.email}>
              <Td>
                <Link href={`/roles-staff/staff/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
                {row.id === viewerId && <span className="text-neutral-600"> (Anda)</span>}
              </Td>
              <Td className="break-all text-neutral-700">{row.email}</Td>
              <Td className="text-neutral-700">{row.roleName}</Td>
              <Td>
                <StaffStatusBadge status={row.status} />
              </Td>
              <Td className="whitespace-nowrap text-neutral-700">{lastLoginText(row.lastLoginAt)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
