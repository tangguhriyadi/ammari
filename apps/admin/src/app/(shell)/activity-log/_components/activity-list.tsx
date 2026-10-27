import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { DEFAULT_RANGE_DAYS } from "@/lib/activity-log/filters";
import type { ActivityActor, ActivityLogRow, EntityRef } from "@/lib/activity-log/queries";

export function ActorLabel({ actor }: { actor: ActivityActor }) {
  if (actor.kind !== "staff") return <span className="text-neutral-700">{actor.label}</span>;
  return (
    <span className="flex flex-col">
      <span className="text-neutral-900">{actor.name}</span>
      <span className="break-all text-sm text-neutral-600">{actor.email}</span>
    </span>
  );
}

export function EntityLink({ entity }: { entity: EntityRef }) {
  return (
    <span className="flex flex-col">
      <span className="text-sm text-neutral-600">{entity.typeLabel}</span>
      {entity.href ? (
        <Link href={entity.href} className="break-words font-medium text-brand hover:underline">
          {entity.label}
        </Link>
      ) : (
        <span className="break-words text-neutral-900">{entity.label}</span>
      )}
    </span>
  );
}

function DetailLink({ row }: { row: ActivityLogRow }) {
  return (
    <Link href={`/activity-log/${row.id}`} className="font-medium text-brand hover:underline">
      {row.actionLabel}
    </Link>
  );
}

export function ActivityList({ rows, filtered }: { rows: ActivityLogRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState title="Tidak ada aktivitas yang cocok" description="Ubah tanggal atau filter, lalu terapkan lagi." />
    ) : (
      <EmptyState title={`Belum ada aktivitas ${DEFAULT_RANGE_DAYS} hari terakhir`} description="Perubahan oleh staf, pembeli, dan sistem muncul di sini." />
    );
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid="activity-row">
            <Card className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-3">
                <DetailLink row={row} />
                <Badge className="shrink-0 whitespace-nowrap">{row.areaLabel}</Badge>
              </div>
              <EntityLink entity={row.entity} />
              <div className="flex flex-wrap items-end justify-between gap-2 text-base">
                <ActorLabel actor={row.actor} />
                <span className="text-sm tabular-nums text-neutral-600">{formatDateTime(row.createdAt)}</span>
              </div>
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Waktu</Th>
          <Th>Pelaku</Th>
          <Th>Aktivitas</Th>
          <Th>Data</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid="activity-row">
              <Td className="whitespace-nowrap tabular-nums text-neutral-700">{formatDateTime(row.createdAt)}</Td>
              <Td>
                <ActorLabel actor={row.actor} />
              </Td>
              <Td>
                <span className="flex flex-col items-start gap-1">
                  <DetailLink row={row} />
                  <Badge>{row.areaLabel}</Badge>
                </span>
              </Td>
              <Td>
                <EntityLink entity={row.entity} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
