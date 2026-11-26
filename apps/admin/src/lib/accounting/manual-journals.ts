import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { inReadCommitted, insertLines, insertReversal, loadClosedMonths, nextEntryNo, truncateDescription } from "@ammari/accounting/ledger-write";
import { ACCOUNTING_CUTOVER_DATE, accounts, journalEntries, privateFiles } from "@ammari/db/schema";
import { ActionError, FieldError, isPostgresErrorCode } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { privateFileValues } from "@/lib/supplier-payments/payment-records";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import {
  MANUAL_JOURNAL_MESSAGES,
  normalizeReversalReason,
  validateManualJournal,
  type ManualJournalFormInput,
  type PostableAccountInfo,
  type ValidatedManualJournal,
} from "./manual-journal-input";

// Manual journals and their reversal (docs/plans/accounting.md §5, §7 "no edits, ever", Session 4).
// Callers check accounting.view + accounting.manage. Each write is ONE READ COMMITTED transaction
// (the 0049 period-lock trigger refuses any other level): the optional attachment's private_files
// row, the entry, its lines and the audit entry. The attachment object is stored BEFORE the
// transaction (store-upload.ts), like every private upload. A wrong manual journal is never edited:
// it is reversed (a mirrored entry, dated in the first open month when its own month is closed,
// D-23) and entered again.

const REVERSAL_CLOSED_MESSAGE = "Bulan berubah status saat jurnal dibalik. Muat ulang halaman lalu coba lagi.";

export const OPENING_MESSAGES = {
  januaryClosed: "Januari 2027 sudah ditutup. Buka kembali Januari 2027 dulu untuk membalik atau membukukan ulang saldo awal.",
} as const;

/** The 0049 trigger's refusal of a closed month, as the form's message; anything else rethrown. */
export function mapJournalWriteError(error: unknown, closedMonth: { field: string; message: string } | { message: string } = { field: "entryDate", message: MANUAL_JOURNAL_MESSAGES.closedMonth }): never {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const message = cause instanceof Error ? cause.message : "";
  if (isPostgresErrorCode(error, "23514") && /accounting period .* is closed/.test(message)) {
    // A close that committed between the app's check and the insert (the trigger is the backstop).
    if ("field" in closedMonth) throw new FieldError(closedMonth.field, closedMonth.message);
    throw new ActionError(closedMonth.message);
  }
  if (isPostgresErrorCode(error, "23514") && /journal_lines_postable_account|header or inactive/.test(message)) {
    throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.accountNotPostable);
  }
  throw error;
}

export async function loadPostableAccountMap(db: Database): Promise<Map<string, PostableAccountInfo>> {
  const rows = await db.select({ code: accounts.code, isActive: accounts.isActive, isHeader: accounts.isHeader }).from(accounts);
  return new Map(rows.map((row) => [row.code, { isActive: row.isActive, isHeader: row.isHeader }]));
}

export interface JournalAccountChoice {
  code: string;
  name: string;
  systemKey: string | null;
}

/** Active postable accounts in chart order (the line pickers), with their system key so the
 * templates resolve to today's codes. */
export async function listJournalAccountChoices(db: Database = defaultDb): Promise<JournalAccountChoice[]> {
  const rows = await db
    .select({ code: accounts.code, name: sql<string>`${accounts.name}::text`, systemKey: accounts.systemKey, isActive: accounts.isActive, isHeader: accounts.isHeader })
    .from(accounts)
    .orderBy(asc(accounts.sortOrder), asc(accounts.code));
  return rows.filter((row) => row.isActive && !row.isHeader).map(({ code, name, systemKey }) => ({ code, name, systemKey }));
}

/** Validates against the accounts and closed months as they are now (call before storing the
 * attachment, so a refused form leaves no object behind). */
export async function prevalidateManualJournal(input: ManualJournalFormInput, db: Database = defaultDb, now: Date = new Date()): Promise<ValidatedManualJournal> {
  const [accountMap, closedMonths] = await Promise.all([loadPostableAccountMap(db), loadClosedMonths(db)]);
  return validateManualJournal(input, { today: todayInJakarta(now), accounts: accountMap, closedMonths });
}

interface InsertJournalInput {
  kind: "manual" | "opening";
  entryDate: string;
  description: string;
  lines: ValidatedManualJournal["lines"];
  file: StoredPrivateFile | null;
  actorStaffUserId: string;
}

/** The entry, its lines and the attachment row, in `tx`. */
export async function insertStaffJournal(tx: Tx, input: InsertJournalInput) {
  if (input.file && input.file.purpose !== "journal_attachment") throw new Error(`expected a journal_attachment file, got ${input.file.purpose}`);
  const fileRow = input.file ? (await tx.insert(privateFiles).values(privateFileValues(input.file, input.actorStaffUserId)).returning())[0] : null;
  if (input.file && !fileRow) throw new Error("failed to insert the journal attachment");
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      entryNo: await nextEntryNo(tx, input.entryDate),
      entryDate: input.entryDate,
      kind: input.kind,
      description: truncateDescription(input.description),
      postedByStaffUserId: input.actorStaffUserId,
      attachmentFileId: fileRow?.id ?? null,
      attachmentFilePurpose: fileRow ? "journal_attachment" : null,
    })
    .returning();
  if (!entry) throw new Error("failed to insert the journal entry");
  await insertLines(tx, entry.id, input.lines);
  return { entry, fileRow };
}

/** "Catat jurnal manual" (plan §5). Re-validated inside the transaction against the accounts and
 * closed months as they are then; the triggers are the backstop. */
export async function postManualJournal(
  input: ManualJournalFormInput,
  file: StoredPrivateFile | null,
  actorStaffUserId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
) {
  try {
    return await inReadCommitted(db, async (tx) => {
      const [accountMap, closedMonths] = await Promise.all([loadPostableAccountMap(tx), loadClosedMonths(tx)]);
      const values = validateManualJournal(input, { today: todayInJakarta(now), accounts: accountMap, closedMonths });
      const { entry, fileRow } = await insertStaffJournal(tx, { kind: "manual", ...values, file, actorStaffUserId });
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create_manual",
        entityType: "journal_entry",
        entityId: entry.id,
        after: { entry, lines: values.lines, file: fileRow },
      });
      return entry;
    });
  } catch (error) {
    mapJournalWriteError(error);
  }
}

/** "Balik jurnal" for a manual or opening journal (plan §7: a wrong manual journal is reversed and
 * re-entered). The target row is locked FOR UPDATE, so two concurrent reversals serialise and the
 * second sees the stamp. System journals are re-derived by the engine, never reversed by hand. */
export async function reverseStaffJournal(entryId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = normalizeReversalReason(reason);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId)) throw new ActionError(MANUAL_JOURNAL_MESSAGES.notFound);
  try {
    return await inReadCommitted(db, async (tx) => {
      const [target] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId)).for("update");
      if (!target) throw new ActionError(MANUAL_JOURNAL_MESSAGES.notFound);
      if (target.kind !== "manual" && target.kind !== "opening") throw new ActionError(MANUAL_JOURNAL_MESSAGES.notManual);
      if (target.reversedByEntryId) throw new ActionError(MANUAL_JOURNAL_MESSAGES.alreadyReversed);
      // The opening journal is dated 2027-01-01 (journal_entries_opening_date_check): reversing it
      // into a later month while January is closed would leave a gap no new opening could fill.
      if (target.kind === "opening" && (await loadClosedMonths(tx)).has(ACCOUNTING_CUTOVER_DATE)) throw new ActionError(OPENING_MESSAGES.januaryClosed);
      const reversal = await insertReversal(tx, target, `Pembalik ${target.entryNo}: ${trimmed}`, actorStaffUserId);
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "reverse",
        entityType: "journal_entry",
        entityId: target.id,
        before: target,
        after: { reason: trimmed, reversal },
      });
      return reversal;
    });
  } catch (error) {
    if (error instanceof ActionError) throw error;
    mapJournalWriteError(error, { message: REVERSAL_CLOSED_MESSAGE });
  }
}
