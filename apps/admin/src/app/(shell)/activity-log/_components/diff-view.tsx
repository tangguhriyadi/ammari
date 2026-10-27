import type { DiffRow, DisplayValue, EntryDiff } from "@/lib/activity-log/diff";
import { REDACTED_TEXT } from "@/lib/activity-log/fields";

// Before/after of one audit row (docs/plans/activity-log.md §3). Plain <details> for the long
// values and the unchanged fields: collapsible without any client JS.

function Value({ value }: { value: DisplayValue | null }) {
  if (value === null || value.kind === "empty") return <span className="text-neutral-500">(kosong)</span>;
  if (value.kind === "redacted") return <span className="italic text-neutral-500">{REDACTED_TEXT}</span>;
  if (value.kind === "text") return <span className="break-words text-neutral-900">{value.text}</span>;
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-neutral-700">{value.summary}</summary>
      <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-2 text-sm text-neutral-800">{value.text}</pre>
    </details>
  );
}

function Rows({ rows, mode }: { rows: DiffRow[]; mode: EntryDiff["mode"] }) {
  const twoSided = mode === "change";
  return (
    <dl className="divide-y divide-neutral-100">
      {rows.map((row) => (
        <div key={row.key} data-testid="diff-row" className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:gap-4">
          <dt className="break-words text-sm font-medium text-neutral-600">{row.label}</dt>
          <dd className="min-w-0 text-base">
            {twoSided ? (
              <div className="grid grid-cols-1 gap-1 md:grid-cols-2 md:gap-4">
                <div className="min-w-0">
                  <span className="mr-1 text-sm text-neutral-500 md:sr-only">Sebelum:</span>
                  <Value value={row.before} />
                </div>
                <div className="min-w-0">
                  <span className="mr-1 text-sm text-neutral-500 md:sr-only">Sesudah:</span>
                  <Value value={row.after} />
                </div>
              </div>
            ) : (
              <Value value={mode === "removed" ? row.before : row.after} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DiffView({ diff }: { diff: EntryDiff }) {
  if (diff.mode === "empty") return <p className="text-base text-neutral-600">Tidak ada data sebelum atau sesudah untuk aktivitas ini.</p>;

  const changed = diff.rows.filter((row) => row.changed);
  const unchanged = diff.rows.filter((row) => !row.changed);
  const heading = diff.mode === "change" ? "Perubahan" : diff.mode === "created" ? "Data yang dicatat" : "Data sebelum dihapus atau dibatalkan";

  return (
    <section aria-labelledby="diff-heading" className="flex flex-col gap-2">
      <h2 id="diff-heading" className="text-lg font-semibold text-neutral-900">
        {heading}
      </h2>
      {diff.mode === "change" && (
        <div aria-hidden="true" className="hidden grid-cols-[minmax(10rem,14rem)_1fr] gap-4 text-sm font-medium text-neutral-500 md:grid">
          <span>Field</span>
          <span className="grid grid-cols-2 gap-4">
            <span>Sebelum</span>
            <span>Sesudah</span>
          </span>
        </div>
      )}
      {changed.length > 0 ? <Rows rows={changed} mode={diff.mode} /> : <p className="text-base text-neutral-600">Tidak ada field yang berubah.</p>}
      {unchanged.length > 0 && (
        <details className="rounded-lg border border-neutral-200 px-4 py-2">
          <summary className="cursor-pointer text-base text-neutral-700">{unchanged.length} field tidak berubah</summary>
          <Rows rows={unchanged} mode={diff.mode} />
        </details>
      )}
    </section>
  );
}
