import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0052 (Akuntansi Session 4: opening balances, manual journals with an attachment, period
// close; docs/plans/accounting.md §5, §7). Upgrades a 0051 database holding a manual journal and an
// expense proof, then proves against the real constraints and the 0049 triggers (which this
// migration relies on unchanged):
//   - the opening journal: dated exactly 2027-01-01, at most one active, balanced at commit; a
//     reversal frees the slot for a corrected one;
//   - attachments: only a private_files row of purpose journal_attachment, only on a manual or
//     opening journal, one file per journal;
//   - close: a closed month refuses every new journal (manual and opening alike); the trial month
//     2026-12 is never closed; a reopen needs a written reason; the close override reason lives only
//     on a closed month.
//
// Commits for real (deferred balance trigger, closed periods), so it owns a disposable database.

const SCRATCH_DATABASE = "ammari_scratch_migration_0052";

type Client = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
let client: Client;
let upTo0051: string;
let upTo0052: string;
let staffId: string;
let entryCounter = 0;

function nextEntryNo(date: string): string {
  entryCounter += 1;
  return `JU-${date.slice(0, 4)}${date.slice(5, 7)}-${String(entryCounter).padStart(4, "0")}`;
}

async function insertFile(purpose: string): Promise<string> {
  const id = randomUUID();
  const sha = id.replaceAll("-", "").padEnd(64, "a");
  await client`
    insert into private_files (id, purpose, storage_key, content_type, byte_size, sha256, original_filename, original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
    values (${id}, ${purpose}, ${`test/${purpose}/${id}.jpg`}, 'image/jpeg', 1, ${sha}, 'lampiran.jpg', 'image/jpeg', 1, ${sha}, ${staffId})`;
  return id;
}

interface EntryOptions {
  date: string;
  kind: "manual" | "opening" | "system";
  lines: [string, number, number][];
  attachment?: { id: string; purpose: string };
}

async function insertEntry(tx: Tx, options: EntryOptions): Promise<string> {
  const isSystem = options.kind === "system";
  const [entry] = await tx`
    insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id, source_type, source_id, source_event, rule_version, attachment_file_id, attachment_file_purpose)
    values (${nextEntryNo(options.date)}, ${options.date}, ${options.kind}, 'Uji', ${isSystem ? null : staffId},
      ${isSystem ? "business_expense" : null}, ${isSystem ? randomUUID() : null}, ${isSystem ? "paid" : null}, ${isSystem ? 1 : null},
      ${options.attachment?.id ?? null}, ${options.attachment?.purpose ?? null})
    returning id`;
  let lineNo = 0;
  for (const [account, debit, credit] of options.lines) {
    lineNo += 1;
    await tx`insert into journal_lines (entry_id, line_no, account_code, debit, credit) values (${entry!.id}, ${lineNo}, ${account}, ${debit}, ${credit})`;
  }
  return entry!.id as string;
}

async function post(options: EntryOptions): Promise<string> {
  return client.begin((tx) => insertEntry(tx, options)) as Promise<string>;
}

/** Reverses `id` the way the app does: mirrored lines, then the one-time stamp. */
async function reverse(id: string, date: string): Promise<string> {
  return client.begin(async (tx) => {
    const lines = await tx`select account_code, debit, credit from journal_lines where entry_id = ${id} order by line_no`;
    const [reversal] = await tx`
      insert into journal_entries (entry_no, entry_date, kind, description, reverses_entry_id, posted_by_staff_user_id)
      values (${nextEntryNo(date)}, ${date}, 'reversal', 'Pembalik uji', ${id}, ${staffId}) returning id`;
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await tx`insert into journal_lines (entry_id, line_no, account_code, debit, credit) values (${reversal!.id}, ${lineNo}, ${line.account_code}, ${line.credit}, ${line.debit})`;
    }
    await tx`update journal_entries set reversed_by_entry_id = ${reversal!.id} where id = ${id}`;
    return reversal!.id as string;
  }) as Promise<string>;
}

const OPENING_LINES: [string, number, number][] = [
  ["1-1201", 10_000_000, 0],
  ["1-1501", 4_000_000, 0],
  ["3-9001", 0, 14_000_000],
];

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 4, onnotice: () => {} });
  upTo0051 = migrationsUpTo(51);
  upTo0052 = migrationsUpTo(52);
  await migrate(drizzle(client), { migrationsFolder: upTo0051 });

  // What a 0051 database may hold: a staff user, an expense proof and a manual journal.
  const [role] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
  staffId = staff!.id as string;
  await insertFile("expense_proof");
  await client.begin(async (tx) => {
    const [entry] = await tx`
      insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id)
      values (${nextEntryNo("2026-12-10")}, '2026-12-10', 'manual', 'Top-up Biteship', ${staffId}) returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_code, debit, credit) values (${entry!.id}, 1, '1-1603', 500000, 0), (${entry!.id}, 2, '1-1201', 0, 500000)`;
  });

  await migrate(drizzle(client), { migrationsFolder: upTo0052 });
});

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0051, upTo0052]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("upgrade from 0051", () => {
  test("every constraint is validated and existing journals carry no attachment", async () => {
    const [{ invalid }] = (await client`select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
    expect(invalid).toBe(0);
    const [{ count }] = (await client`select count(*)::int as count from journal_entries where attachment_file_id is not null`) as unknown as [{ count: number }];
    expect(count).toBe(0);
  });
});

describe("the opening journal (D-22)", () => {
  test("is dated exactly the cut-over day 2027-01-01", async () => {
    await expect(post({ date: "2027-01-05", kind: "opening", lines: OPENING_LINES })).rejects.toThrow(/journal_entries_opening_date_check/);
    await expect(post({ date: "2026-12-31", kind: "opening", lines: OPENING_LINES })).rejects.toThrow(/journal_entries_opening_date_check/);
  });

  test("must balance at commit", async () => {
    await expect(post({ date: "2027-01-01", kind: "opening", lines: [["1-1201", 10_000_000, 0], ["3-9001", 0, 9_000_000]] })).rejects.toThrow(/does not balance/);
  });

  test("only one is active; reversing it frees the slot for a corrected one", async () => {
    const first = await post({ date: "2027-01-01", kind: "opening", lines: OPENING_LINES });
    await expect(post({ date: "2027-01-01", kind: "opening", lines: OPENING_LINES })).rejects.toThrow(/journal_entries_one_active_opening/);
    await reverse(first, "2027-01-01");
    const second = await post({ date: "2027-01-01", kind: "opening", lines: OPENING_LINES });
    const active = await client`select id from journal_entries where kind = 'opening' and reversed_by_entry_id is null`;
    expect(active.map((row) => row.id)).toEqual([second]);
  });
});

describe("journal attachments (plan §5)", () => {
  test("a manual journal takes a journal_attachment file", async () => {
    const fileId = await insertFile("journal_attachment");
    const entryId = await post({ date: "2027-01-07", kind: "manual", lines: [["1-1603", 1_000_000, 0], ["1-1201", 0, 1_000_000]], attachment: { id: fileId, purpose: "journal_attachment" } });
    const [row] = await client`select attachment_file_id from journal_entries where id = ${entryId}`;
    expect(row!.attachment_file_id).toBe(fileId);
  });

  test("never another purpose's file, never a file named under the wrong purpose, never one file twice", async () => {
    const proofId = await insertFile("expense_proof");
    await expect(post({ date: "2027-01-07", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]], attachment: { id: proofId, purpose: "expense_proof" } })).rejects.toThrow(
      /journal_entries_attachment_check/,
    );
    // The composite FK pins the purpose: an expense proof cannot be passed off as an attachment.
    await expect(post({ date: "2027-01-07", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]], attachment: { id: proofId, purpose: "journal_attachment" } })).rejects.toThrow(
      /journal_entries_attachment_file_fk/,
    );
    const fileId = await insertFile("journal_attachment");
    await post({ date: "2027-01-08", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]], attachment: { id: fileId, purpose: "journal_attachment" } });
    await expect(post({ date: "2027-01-08", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]], attachment: { id: fileId, purpose: "journal_attachment" } })).rejects.toThrow(
      /journal_entries_attachment_file_id_unique/,
    );
  });

  test("a system journal never carries an attachment, and private_files purposes stay a closed list", async () => {
    const fileId = await insertFile("journal_attachment");
    await expect(post({ date: "2027-01-09", kind: "system", lines: [["6-2101", 1, 0], ["1-1201", 0, 1]], attachment: { id: fileId, purpose: "journal_attachment" } })).rejects.toThrow(
      /journal_entries_attachment_check/,
    );
    await expect(insertFile("random_purpose")).rejects.toThrow(/private_files_purpose_check/);
  });

  test("an attachment is append-only like its journal: it cannot be added or swapped later", async () => {
    const entryId = await post({ date: "2027-01-10", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]] });
    const fileId = await insertFile("journal_attachment");
    await expect(client`update journal_entries set attachment_file_id = ${fileId}, attachment_file_purpose = 'journal_attachment' where id = ${entryId}`).rejects.toThrow(/append-only/);
  });
});

describe("period close (D-23) with the new override reason", () => {
  test("a closed month refuses manual and opening journals; reopening needs a written reason; the trial month is never closed", async () => {
    await client`insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id, close_override_reason)
      values ('2027-02-01', 'closed', now(), ${staffId}, 'Impor Shopee Februari menyusul')`;
    await expect(post({ date: "2027-02-15", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]] })).rejects.toThrow(/accounting period 2027-02 is closed/);

    await expect(client`update fiscal_periods set status = 'open', close_override_reason = null where month = '2027-02-01'`).rejects.toThrow(/reopening needs a new reopened_at/);
    await expect(
      client`update fiscal_periods set status = 'open', close_override_reason = null, reopened_at = now(), reopened_by_staff_user_id = ${staffId}, reopened_reason = '  ' where month = '2027-02-01'`,
    ).rejects.toThrow(/reopen/);
    await client`update fiscal_periods set status = 'open', close_override_reason = null, reopened_at = now(), reopened_by_staff_user_id = ${staffId}, reopened_reason = 'Biaya Februari terlewat' where month = '2027-02-01'`;
    await post({ date: "2027-02-15", kind: "manual", lines: [["1-1603", 1, 0], ["1-1201", 0, 1]] });

    await expect(client`insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id) values ('2026-12-01', 'closed', now(), ${staffId})`).rejects.toThrow(
      /fiscal_periods_trial_month_open_check/,
    );
  });

  test("the override reason only on a closed month, never blank", async () => {
    await expect(client`insert into fiscal_periods (month, status, close_override_reason) values ('2027-03-01', 'open', 'alasan')`).rejects.toThrow(/fiscal_periods_close_override_reason_check/);
    await expect(client`insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id, close_override_reason) values ('2027-03-01', 'closed', now(), ${staffId}, ' ')`).rejects.toThrow(
      /fiscal_periods_close_override_reason_check/,
    );
    // A reopen that keeps the override reason is refused: the app clears it.
    await client`insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id, close_override_reason) values ('2027-03-01', 'closed', now(), ${staffId}, 'Laporan Midtrans menyusul')`;
    await expect(
      client`update fiscal_periods set status = 'open', reopened_at = now(), reopened_by_staff_user_id = ${staffId}, reopened_reason = 'Koreksi' where month = '2027-03-01'`,
    ).rejects.toThrow(/fiscal_periods_close_override_reason_check/);
  });

  test("the opening journal cannot be entered while January 2027 is closed", async () => {
    await client`insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id) values ('2027-01-01', 'closed', now(), ${staffId})`;
    const [{ count: before }] = (await client`select count(*)::int as count from journal_entries where kind = 'opening' and reversed_by_entry_id is null`) as unknown as [{ count: number }];
    expect(before).toBe(1);
    const [active] = await client`select id from journal_entries where kind = 'opening' and reversed_by_entry_id is null`;
    // Reversing into January is refused (closed); the app refuses before trying (manual-journals.ts).
    await expect(reverse(active!.id as string, "2027-01-01")).rejects.toThrow(/accounting period 2027-01 is closed/);
  });
});
