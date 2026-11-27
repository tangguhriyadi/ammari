import type { PostingStatus } from "@/lib/accounting/posting-status";

// The posting warning (a failed last run, or the automatic posting not running), shown on Jurnal
// umum and Rekonsiliasi. Nothing when all is well; the summary line goes in the page description.

export function PostingStatusNotice({ status }: { status: PostingStatus }) {
  if (!status.warning) return null;
  return (
    <p role="status" data-testid="posting-status-warning" className="mb-4 rounded-lg border border-warning-700/30 bg-warning-50 p-4 text-base text-warning-700">
      {status.warning}
    </p>
  );
}
