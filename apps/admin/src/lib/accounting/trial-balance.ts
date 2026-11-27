import "server-only";
import { sql } from "drizzle-orm";
import { resolveReportRange, type ReportRange } from "@ammari/accounting";
import type { AccountType } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import type { DateRange } from "./filters";

// Neraca saldo (docs/plans/accounting.md §6, Session 4): every account with a balance or movement in
// the range, opening / debit / credit / closing, which must balance. Balances are summed within one
// set of books only (books.ts): from 1 Dec 2026 for the December trial month, from the cut-over
// 1 Jan 2027 (the opening journal) for the official books, so December never reaches a 2027 figure.
// Opening and closing balances are shown on their own side (a debit balance in the debit column).
// The opening journal dated 1 Jan 2027 shows as the opening balance, not as January's movement.

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  isActive: boolean;
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalanceTotals {
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalance {
  range: ReportRange;
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
  balanced: boolean;
  generatedAt: Date;
}

/** The opening journal (and a reversal of it) is the official books' opening balance, never a
 * movement of January: it always counts as "before" the range. Needs `e` (the entry) and
 * `reversed` (the entry it reverses, left-joined; NULL for an ordinary entry, hence the coalesce:
 * `not (... or NULL)` would drop every ordinary movement). */
export const IS_OPENING_SQL = sql.raw(`(e.kind = 'opening' or coalesce(reversed.kind = 'opening', false))`);

/** A year-end closing journal (Session 11, plan §5.7) and a reversal of it: it moves the year's
 * result into Saldo laba, so it is never a revenue or an expense of the period (Laba rugi and its
 * reconciliation leave it out). Same `e` / `reversed` aliases as IS_OPENING_SQL. */
export const IS_CLOSING_SQL = sql.raw(`(e.kind = 'closing' or coalesce(reversed.kind = 'closing', false))`);

const side = (signed: number) => ({ debit: signed > 0 ? signed : 0, credit: signed < 0 ? -signed : 0 });

export async function getTrialBalance(requested: DateRange, db: Database = defaultDb, now: Date = new Date()): Promise<TrialBalance> {
  const range = resolveReportRange(requested);
  const result = (await db.execute(sql`
    select a.code, a.name::text as name, a.type, a.is_active,
      coalesce(sum(l.debit - l.credit) filter (where e.entry_date < ${range.from} or ${IS_OPENING_SQL}), 0)::bigint as opening,
      coalesce(sum(l.debit) filter (where e.entry_date >= ${range.from} and not ${IS_OPENING_SQL}), 0)::bigint as debit,
      coalesce(sum(l.credit) filter (where e.entry_date >= ${range.from} and not ${IS_OPENING_SQL}), 0)::bigint as credit
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    join accounts a on a.code = l.account_code
    where e.entry_date >= ${range.segmentStart} and e.entry_date <= ${range.to}
    group by a.code, a.name, a.type, a.is_active, a.sort_order
    order by a.sort_order, a.code
  `)) as unknown as { code: string; name: string; type: AccountType; is_active: boolean; opening: string; debit: string; credit: string }[];

  const rows: TrialBalanceRow[] = [];
  for (const row of result) {
    const opening = Number(row.opening);
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    if (opening === 0 && debit === 0 && credit === 0) continue;
    const openingSide = side(opening);
    const closingSide = side(opening + debit - credit);
    rows.push({
      code: row.code,
      name: row.name,
      type: row.type,
      isActive: row.is_active,
      openingDebit: openingSide.debit,
      openingCredit: openingSide.credit,
      debit,
      credit,
      closingDebit: closingSide.debit,
      closingCredit: closingSide.credit,
    });
  }
  const totals = rows.reduce<TrialBalanceTotals>(
    (sum, row) => ({
      openingDebit: sum.openingDebit + row.openingDebit,
      openingCredit: sum.openingCredit + row.openingCredit,
      debit: sum.debit + row.debit,
      credit: sum.credit + row.credit,
      closingDebit: sum.closingDebit + row.closingDebit,
      closingCredit: sum.closingCredit + row.closingCredit,
    }),
    { openingDebit: 0, openingCredit: 0, debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 },
  );
  const balanced = totals.openingDebit === totals.openingCredit && totals.debit === totals.credit && totals.closingDebit === totals.closingCredit;
  return { range, rows, totals, balanced, generatedAt: now };
}

export type TrialBalanceFormat = "pdf" | "xlsx";

export async function recordTrialBalanceDownload(actorStaffUserId: string, report: TrialBalance, format: TrialBalanceFormat, db: Database = defaultDb): Promise<void> {
  await writeAuditLog(db, {
    actorStaffUserId,
    action: "download",
    entityType: "trial_balance",
    entityId: `${report.range.from}_${report.range.to}`,
    after: { format, from: report.range.from, to: report.range.to, rowCount: report.rows.length, balanced: report.balanced },
  });
}
