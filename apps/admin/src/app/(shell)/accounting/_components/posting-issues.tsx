import { formatDay } from "@/lib/accounting/format";
import { postingIssueMessage, sourceEventLabel, sourceTypeLabel } from "@/lib/accounting/labels";
import type { PostingIssueRow } from "@/lib/accounting/queries";

// The open posting-issue queue (docs/plans/accounting.md §2): sources the engine could not book,
// never silently skipped. Each one stays here until a later posting run books it.

export function PostingIssues({ rows, totalCount }: { rows: PostingIssueRow[]; totalCount: number }) {
  if (totalCount === 0) return null;
  return (
    <section aria-labelledby="posting-issues-heading" className="mb-6 rounded-lg border border-warning-700/30 bg-warning-50 p-4">
      <h2 id="posting-issues-heading" className="text-base font-semibold text-warning-700">
        {totalCount} sumber belum bisa dibukukan
      </h2>
      <p className="mt-1 text-sm text-neutral-700">Perbaiki penyebabnya, lalu jalankan posting lagi.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {rows.map((issue) => {
          const event = sourceEventLabel(issue.sourceEvent);
          return (
            <li key={issue.id} data-testid="posting-issue" className="rounded-md bg-white p-3 text-base">
              <p className="text-sm text-neutral-600">
                {sourceTypeLabel(issue.sourceType)}
                {event ? ` (${event.toLowerCase()})` : ""}
                {issue.documentNo ? `: ${issue.documentNo}` : ""}
                {issue.sourceDate ? `, ${formatDay(issue.sourceDate)}` : ""}
              </p>
              <p className="text-neutral-900">{postingIssueMessage(issue.issueCode, issue.details)}</p>
            </li>
          );
        })}
      </ul>
      {totalCount > rows.length && <p className="mt-2 text-sm text-neutral-700">Dan {totalCount - rows.length} lainnya.</p>}
    </section>
  );
}
