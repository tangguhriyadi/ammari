import Link from "next/link";
import { Badge, Card, CardList, EmptyState } from "@ammari/ui";
import { formatAmount, formatDay } from "@/lib/accounting/format";
import { JOURNAL_KIND_LABELS, sourceEventLabel, sourceTypeLabel } from "@/lib/accounting/labels";
import type { JournalEntryRow, JournalLineRow, SourceRef } from "@/lib/accounting/queries";

// Jurnal umum (docs/plans/accounting.md §6): each entry with its lines; reversals linked both ways.
// Phones get a card per entry, tablet/desktop a table where each entry is its own row group.

function SourceLabel({ entry }: { entry: JournalEntryRow }) {
  const event = sourceEventLabel(entry.sourceEvent);
  const prefix = `${sourceTypeLabel(entry.sourceType)}${event ? ` (${event.toLowerCase()})` : ""}`;
  return (
    <span className="text-sm text-neutral-600">
      {prefix}
      {entry.source && (
        <>
          {": "}
          <SourceLink source={entry.source} />
        </>
      )}
    </span>
  );
}

function SourceLink({ source }: { source: SourceRef }) {
  if (!source.href) return <span className="text-neutral-900">{source.label}</span>;
  return (
    <Link href={source.href} className="font-medium text-brand hover:underline">
      {source.label}
    </Link>
  );
}

function EntryNotes({ entry }: { entry: JournalEntryRow }) {
  const notes: string[] = [];
  if (entry.reversesEntryNo) notes.push(`Membalik ${entry.reversesEntryNo}`);
  if (entry.reversedByEntryNo) notes.push(`Dibalik oleh ${entry.reversedByEntryNo}`);
  if (entry.sourceDate && entry.sourceDate !== entry.entryDate) notes.push(`Tanggal sumber ${formatDay(entry.sourceDate)}`);
  if (notes.length === 0) return null;
  return <span className="text-sm text-neutral-600">{notes.join(" · ")}</span>;
}

function KindBadge({ entry }: { entry: JournalEntryRow }) {
  return <Badge variant={entry.kind === "reversal" ? "warning" : "neutral"}>{JOURNAL_KIND_LABELS[entry.kind]}</Badge>;
}

function AccountName({ line }: { line: JournalLineRow }) {
  // Credit lines are indented, the usual journal layout.
  return (
    <span className={line.credit > 0 ? "pl-6" : undefined}>
      <span className="tabular-nums text-neutral-600">{line.accountCode}</span> {line.accountName}
    </span>
  );
}

export function JournalList({ rows, filtered }: { rows: JournalEntryRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState title="Tidak ada jurnal yang cocok" description="Ubah tanggal atau filter, lalu terapkan lagi." />
    ) : (
      <EmptyState title="Belum ada jurnal bulan ini" description="Jurnal dibuat otomatis dari biaya dan pembayaran supplier saat posting dijalankan." />
    );
  }

  return (
    <>
      <CardList>
        {rows.map((entry) => (
          <li key={entry.id} data-testid="journal-entry-card">
            <Card className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium tabular-nums text-neutral-900">{entry.entryNo}</span>
                  <span className="text-sm tabular-nums text-neutral-600">{formatDay(entry.entryDate)}</span>
                </div>
                <KindBadge entry={entry} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="break-words text-neutral-900">{entry.description}</span>
                <SourceLabel entry={entry} />
                <EntryNotes entry={entry} />
              </div>
              <ul className="flex flex-col divide-y divide-neutral-100 border-t border-neutral-100">
                {entry.lines.map((line) => (
                  <li key={line.lineNo} className="flex items-start justify-between gap-3 py-2 text-base">
                    <AccountName line={line} />
                    <span className="flex shrink-0 flex-col items-end tabular-nums">
                      {line.debit > 0 ? <span>Debit {formatAmount(line.debit)}</span> : <span>Kredit {formatAmount(line.credit)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </CardList>

      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
        <table className="w-full text-left text-base" aria-label="Jurnal umum">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
            <tr>
              <th className="whitespace-nowrap px-4 py-3 font-medium">Tanggal</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium">No. jurnal</th>
              <th className="px-4 py-3 font-medium">Keterangan dan akun</th>
              <th className="whitespace-nowrap px-4 py-3 text-right font-medium">Debit</th>
              <th className="whitespace-nowrap px-4 py-3 text-right font-medium">Kredit</th>
            </tr>
          </thead>
          {rows.map((entry) => (
            <tbody key={entry.id} data-testid="journal-entry-row" className="border-b border-neutral-200 last:border-0">
              <tr>
                <td className="whitespace-nowrap px-4 pb-1 pt-3 align-top tabular-nums text-neutral-700" rowSpan={entry.lines.length + 1}>
                  {formatDay(entry.entryDate)}
                </td>
                <th scope="rowgroup" className="whitespace-nowrap px-4 pb-1 pt-3 text-left align-top font-normal" rowSpan={entry.lines.length + 1}>
                  <span className="flex flex-col items-start gap-1">
                    <span className="font-medium tabular-nums text-neutral-900">{entry.entryNo}</span>
                    <KindBadge entry={entry} />
                  </span>
                </th>
                <td className="px-4 pb-1 pt-3" colSpan={3}>
                  <span className="flex flex-col gap-0.5">
                    <span className="break-words text-neutral-900">{entry.description}</span>
                    <SourceLabel entry={entry} />
                    <EntryNotes entry={entry} />
                  </span>
                </td>
              </tr>
              {entry.lines.map((line) => (
                <tr key={line.lineNo}>
                  <td className="px-4 py-1">
                    <AccountName line={line} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-1 text-right tabular-nums">{formatAmount(line.debit)}</td>
                  <td className="whitespace-nowrap px-4 py-1 text-right tabular-nums">{formatAmount(line.credit)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
