import "server-only";
import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import {
  journalContentHash,
  monthEndOf,
  OFFICIAL_BOOKS_START,
  PPH_FINAL_RULE_VERSION,
  PPH_FINAL_SOURCE_ID,
  PPH_FINAL_SOURCE_TYPE,
  pphFinalLines,
  pphFinalSourceEvent,
  pphFinalWarning,
  PROFIT_AND_LOSS_ACCOUNT_TYPES,
  proposePphFinal,
  taxSettingFor,
  YEAR_CLOSE_SOURCE_EVENT,
  YEAR_CLOSE_SOURCE_TYPE,
  yearEndClosingLines,
  type JournalLineDraft,
  type PphFinalProposal,
} from "@ammari/accounting";
import { insertLines, insertReversal, nextEntryNo, truncateDescription, type Tx } from "@ammari/accounting/ledger-write";
import { accounts, journalEntries, taxSettings, type AccountType } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { IS_CLOSING_SQL, IS_OPENING_SQL } from "./trial-balance";

// What closing a month posts (docs/plans/accounting.md §5.6, §5.7, §7; D-20; Session 11), inside
// closePeriod's transaction, under the month's exclusive lock (so no other journal can land in the
// month while the figures are read), before the month is set closed:
//   - the PPh final accrual for the month (key tax/pph_final/YYYY-MM, kind system, dated the month's
//     last day), computed from the ledger's net sales and the tax_settings row in force. Shown on the
//     Tutup buku page before the close. No setting, a rate past rate_valid_until or a company taxpayer:
//     nothing is proposed (a warning instead, never a guess);
//   - for December of an official year, the year-end closing journal (key year_close/YYYY/closing,
//     kind closing, dated 31 December): the year's P&L into Saldo laba, Prive into Modal pemilik.
// Both are re-derived on a re-close after a reopen: identical → kept; changed → the old one is
// reversed (dated in the month, which is open again) and the new one posted; nothing left → reversed.
// A late correction after the close lands in the first open month (D-23) and is in that month's base.
// The journals are posted by the staff member closing the month; the close's own audit row lists them,
// and each write has its own audit row too.

/** Content-hash version of the close journals (bump to re-derive them on the next close). */
const CLOSE_JOURNAL_VERSION = PPH_FINAL_RULE_VERSION;

export const PPH_FINAL_EXPENSE_KEY = "tax.pph_final";
export const PPH_FINAL_LIABILITY_KEY = "liability.pph_final";

async function systemAccounts(db: Database): Promise<Map<string, string>> {
  const rows = await db.select({ code: accounts.code, systemKey: accounts.systemKey }).from(accounts).where(sql`${accounts.systemKey} is not null`);
  return new Map(rows.map((row) => [row.systemKey as string, row.code]));
}

function requireSystem(map: Map<string, string>, key: string): string {
  const code = map.get(key);
  if (!code) throw new Error(`system account ${key} is missing from the chart of accounts`);
  return code;
}

/** Σ credit − debit on the revenue and contra-revenue accounts (net sales, D-20 base) for the tax
 * year of `month` before the month and within it, in the official books, leaving out the opening and
 * closing journals. */
async function netSales(db: Database, month: string): Promise<{ ytdBefore: number; monthBase: number }> {
  const yearStart = `${month.slice(0, 4)}-01-01` < OFFICIAL_BOOKS_START ? OFFICIAL_BOOKS_START : `${month.slice(0, 4)}-01-01`;
  const [row] = (await db.execute(sql`
    select coalesce(sum(l.credit - l.debit) filter (where e.entry_date < ${month}), 0)::bigint as ytd_before,
           coalesce(sum(l.credit - l.debit) filter (where e.entry_date >= ${month}), 0)::bigint as month_base
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    join accounts a on a.code = l.account_code
    where a.type in ('revenue', 'contra_revenue')
      and e.entry_date >= ${yearStart} and e.entry_date <= ${monthEndOf(month)}
      and not ${IS_OPENING_SQL} and not ${IS_CLOSING_SQL}
  `)) as unknown as { ytd_before: string; month_base: string }[];
  return { ytdBefore: Number(row?.ytd_before ?? 0), monthBase: Number(row?.month_base ?? 0) };
}

/** The PPh final proposal for an official month (null for the trial month or earlier). */
export async function proposePphFinalFor(month: string, db: Database = defaultDb): Promise<PphFinalProposal | null> {
  if (month < OFFICIAL_BOOKS_START) return null;
  const [settings, sales] = await Promise.all([
    db
      .select({
        effectiveFrom: taxSettings.effectiveFrom,
        taxpayerType: taxSettings.taxpayerType,
        rateBps: taxSettings.rateBps,
        annualExemptionAmount: taxSettings.annualExemptionAmount,
        rateValidUntil: taxSettings.rateValidUntil,
      })
      .from(taxSettings)
      .where(lte(taxSettings.effectiveFrom, month)),
    netSales(db, month),
  ]);
  return proposePphFinal({ month, setting: taxSettingFor(settings, month), ...sales });
}

export { pphFinalWarning };

interface CloseJournalSpec {
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
  kind: "system" | "closing";
  entryDate: string;
  description: string;
  lines: JournalLineDraft[];
}

export type CloseJournalAction = "none" | "unchanged" | "inserted" | "replaced" | "reversed";

export interface CloseJournalResult {
  action: CloseJournalAction;
  entryNo: string | null;
  reversedEntryNo: string | null;
}

/** Keeps, posts, replaces or reverses the one active journal of a close key (see the header). */
async function syncCloseJournal(tx: Tx, spec: CloseJournalSpec, actorStaffUserId: string): Promise<CloseJournalResult> {
  const [active] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.sourceType, spec.sourceType),
        eq(journalEntries.sourceId, spec.sourceId),
        eq(journalEntries.sourceEvent, spec.sourceEvent),
        ne(journalEntries.kind, "reversal"),
        isNull(journalEntries.reversedByEntryId),
      ),
    )
    .for("update");
  const contentHash = spec.lines.length > 0 ? journalContentHash(CLOSE_JOURNAL_VERSION, spec.entryDate, spec.lines) : null;
  if (active && active.contentHash === contentHash) return { action: "unchanged", entryNo: active.entryNo, reversedEntryNo: null };
  let reversedEntryNo: string | null = null;
  if (active) {
    await insertReversal(tx, active, `Pembalik ${active.entryNo}: dihitung ulang saat tutup buku`, actorStaffUserId);
    reversedEntryNo = active.entryNo;
    await writeAuditLog(tx, { actorStaffUserId, action: "reverse_close_posting", entityType: "journal_entry", entityId: active.id, before: active });
  }
  if (spec.lines.length === 0) return { action: active ? "reversed" : "none", entryNo: null, reversedEntryNo };
  const entryNo = await nextEntryNo(tx, spec.entryDate);
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      entryNo,
      entryDate: spec.entryDate,
      sourceDate: spec.entryDate,
      sourceType: spec.sourceType,
      sourceId: spec.sourceId,
      sourceEvent: spec.sourceEvent,
      ruleVersion: CLOSE_JOURNAL_VERSION,
      kind: spec.kind,
      description: truncateDescription(spec.description),
      postedByStaffUserId: actorStaffUserId,
      contentHash,
    })
    .returning();
  if (!entry) throw new Error(`failed to insert the ${spec.sourceType} journal`);
  await insertLines(tx, entry.id, spec.lines);
  if (spec.kind === "closing") {
    await writeAuditLog(tx, { actorStaffUserId, action: "post_year_close", entityType: "journal_entry", entityId: entry.id, after: { entry, lines: spec.lines } });
  } else {
    await writeAuditLog(tx, { actorStaffUserId, action: "post_pph_final", entityType: "journal_entry", entityId: entry.id, after: { entry, lines: spec.lines } });
  }
  return { action: active ? "replaced" : "inserted", entryNo, reversedEntryNo };
}

const rupiah = (amount: number) => `Rp${amount.toLocaleString("id-ID")}`;

async function yearClosingBalances(tx: Tx, year: string) {
  const rows = (await tx.execute(sql`
    select a.code, a.type, coalesce(sum(l.debit - l.credit), 0)::bigint as net
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    join accounts a on a.code = l.account_code
    where e.entry_date >= ${`${year}-01-01`} and e.entry_date <= ${`${year}-12-31`} and not ${IS_CLOSING_SQL}
    group by a.code, a.type
  `)) as unknown as { code: string; type: AccountType; net: string }[];
  return rows.map((row) => ({ code: row.code, type: row.type, net: Number(row.net) }));
}

export interface PeriodClosePostings {
  pphFinal: (CloseJournalResult & { proposal: PphFinalProposal }) | null;
  yearClose: CloseJournalResult | null;
}

/** Called by closePeriod inside its transaction, after the locks and checks, before the status update. */
export async function postPeriodCloseJournals(tx: Tx, month: string, actorStaffUserId: string): Promise<PeriodClosePostings> {
  if (month < OFFICIAL_BOOKS_START) return { pphFinal: null, yearClose: null };
  const system = await systemAccounts(tx);
  const entryDate = monthEndOf(month);

  const proposal = await proposePphFinalFor(month, tx);
  if (!proposal) throw new Error(`no PPh final proposal for official month ${month}`);
  const pphLines = pphFinalLines(proposal, { expense: requireSystem(system, PPH_FINAL_EXPENSE_KEY), liability: requireSystem(system, PPH_FINAL_LIABILITY_KEY) });
  const pphFinal = await syncCloseJournal(
    tx,
    {
      sourceType: PPH_FINAL_SOURCE_TYPE,
      sourceId: PPH_FINAL_SOURCE_ID,
      sourceEvent: pphFinalSourceEvent(month),
      kind: "system",
      entryDate,
      description:
        proposal.kind === "accrual"
          ? `PPh final ${month.slice(0, 7)}: ${proposal.rateBps / 100}% x ${rupiah(proposal.taxable)} (dasar bulan ini ${rupiah(proposal.monthBase)})`
          : `PPh final ${month.slice(0, 7)}`,
      lines: pphLines,
    },
    actorStaffUserId,
  );

  let yearClose: CloseJournalResult | null = null;
  if (month.slice(5, 7) === "12") {
    const year = month.slice(0, 4);
    const lines = yearEndClosingLines(
      (await yearClosingBalances(tx, year)).filter((row) => PROFIT_AND_LOSS_ACCOUNT_TYPES.includes(row.type) || row.code === requireSystem(system, "equity.drawings")),
      {
        retainedEarnings: requireSystem(system, "equity.retained_earnings"),
        drawings: requireSystem(system, "equity.drawings"),
        ownerCapital: requireSystem(system, "equity.owner_capital"),
      },
    );
    yearClose = await syncCloseJournal(
      tx,
      { sourceType: YEAR_CLOSE_SOURCE_TYPE, sourceId: year, sourceEvent: YEAR_CLOSE_SOURCE_EVENT, kind: "closing", entryDate, description: `Jurnal penutup tahun ${year}`, lines },
      actorStaffUserId,
    );
  }
  return { pphFinal: { ...pphFinal, proposal }, yearClose };
}
