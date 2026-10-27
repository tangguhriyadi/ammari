import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Card, PageHeader } from "@ammari/ui";
import { formatDateTime } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { buildEntryDiff } from "@/lib/activity-log/diff";
import { getActivityLogEntry } from "@/lib/activity-log/queries";
import { ActorLabel, EntityLink } from "../_components/activity-list";
import { DiffView } from "../_components/diff-view";

// One audit row (docs/plans/activity-log.md §3). The payload is redacted and turned into display
// rows here on the server (buildEntryDiff); the raw before/after never reach the browser.

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="break-words text-base text-neutral-900">{children}</dd>
    </div>
  );
}

export default async function ActivityLogEntryPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("audit_log.view");
  const { id } = await params;
  const entry = await getActivityLogEntry(id);
  if (!entry) notFound();
  const diff = buildEntryDiff(entry.before, entry.after);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/activity-log"), { label: entry.actionLabel }]} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title={entry.actionLabel} description={formatDateTime(entry.createdAt)} />
        <Badge className="shrink-0 whitespace-nowrap">{entry.areaLabel}</Badge>
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Fact label="Pelaku">
              <ActorLabel actor={entry.actor} />
            </Fact>
            <Fact label="Data">
              <EntityLink entity={entry.entity} />
            </Fact>
            <Fact label="Kode aktivitas">
              <code className="break-all text-sm">
                {entry.entityType} / {entry.action}
              </code>
            </Fact>
            <Fact label="ID data">
              <code className="break-all text-sm">{entry.entityId}</code>
            </Fact>
          </dl>
        </Card>

        <DiffView diff={diff} />

        <Link href="/activity-log" className="text-base font-medium text-brand hover:underline">
          Kembali ke Log Aktivitas
        </Link>
      </div>
    </>
  );
}
