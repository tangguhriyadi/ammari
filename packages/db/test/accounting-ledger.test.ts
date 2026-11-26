import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXPENSE_LIKE_ACCOUNT_TYPES, PURCHASE_SIDE_JOURNAL_SOURCES } from "../src/schema/constants";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// The ledger's database rules (docs/plans/accounting.md §2.1, Session 1), against migration 0049's
// triggers: balanced entries with at least two lines, append-only journals (reversal stamp only),
// lines only in the entry's own transaction, postable/active accounts, closed-period lock (and its
// serialisation with a concurrent close), account and mapping guards, and the D-14 guard that a
// purchase-side journal never touches an expense account.
//
// Every write here COMMITS (the balance check is a deferred constraint trigger that only fires at
// commit; closed periods must persist), so this file owns a disposable database, never
// `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_accounting_ledger";

type Client = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
let client: Client;
let migrationsDir: string;
let staffId: string;
let entryCounter = 0;

interface LineInput {
  account: string;
  debit?: number;
  credit?: number;
  cashAccount?: string;
  channel?: string;
}

interface EntryInput {
  date: string;
  kind?: "system" | "manual" | "opening" | "reversal" | "closing" | "depreciation";
  source?: { type: string; id?: string; event: string };
  reverses?: string;
  lines: LineInput[];
}

async function insertEntry(tx: Tx | Client, entry: EntryInput): Promise<string> {
  entryCounter += 1;
  const kind = entry.kind ?? (entry.source ? "system" : "manual");
  const [row] = await tx`
    insert into journal_entries (entry_no, entry_date, source_type, source_id, source_event, rule_version, kind,
                                 reverses_entry_id, description, posted_by_staff_user_id)
    values (${`JU-202701-${String(entryCounter).padStart(4, "0")}`}, ${entry.date},
            ${entry.source?.type ?? null}, ${entry.source ? (entry.source.id ?? randomUUID()) : null}, ${entry.source?.event ?? null},
            ${kind === "system" ? 1 : null}, ${kind}, ${entry.reverses ?? null}, 'Jurnal uji', ${kind === "system" ? null : staffId})
    returning id`;
  const entryId = row!.id as string;
  let lineNo = 0;
  for (const line of entry.lines) {
    lineNo += 1;
    await tx`
      insert into journal_lines (entry_id, line_no, account_code, debit, credit, cash_account_code, channel_id)
      values (${entryId}, ${lineNo}, ${line.account}, ${line.debit ?? 0}, ${line.credit ?? 0}, ${line.cashAccount ?? null}, ${line.channel ?? null})`;
  }
  return entryId;
}

/** One committed transaction holding one entry and its lines. */
async function post(entry: EntryInput): Promise<string> {
  let id = "";
  await client.begin(async (tx) => {
    id = await insertEntry(tx, entry);
  });
  return id;
}

/** Reverses an entry the way the engine will: a mirrored reversal entry, then the stamp, in one
 * transaction. */
async function reverse(entryId: string, date: string): Promise<string> {
  const lines = await client`select account_code, debit, credit, channel_id from journal_lines where entry_id = ${entryId} order by line_no`;
  const [original] = await client`select source_type, source_id, source_event from journal_entries where id = ${entryId}`;
  let id = "";
  await client.begin(async (tx) => {
    id = await insertEntry(tx, {
      date,
      kind: "reversal",
      reverses: entryId,
      source: original!.source_type ? { type: original!.source_type, id: original!.source_id, event: original!.source_event } : undefined,
      lines: lines.map((line) => ({
        account: line.account_code as string,
        debit: Number(line.credit),
        credit: Number(line.debit),
        channel: (line.channel_id as string | null) ?? undefined,
      })),
    });
    await tx`update journal_entries set reversed_by_entry_id = ${id} where id = ${entryId}`;
  });
  return id;
}

const balanced = (date = "2027-01-15"): EntryInput => ({
  date,
  lines: [
    { account: "1-1201", debit: 1_000_000 },
    { account: "3-1001", credit: 1_000_000 },
  ],
});

async function closeMonth(month: string) {
  await client`
    insert into fiscal_periods (month, status, closed_at, closed_by_staff_user_id) values (${month}, 'closed', now(), ${staffId})
    on conflict (month) do update set status = 'closed', closed_at = now(), closed_by_staff_user_id = ${staffId}`;
}

async function reopenMonth(month: string) {
  await client`
    update fiscal_periods set status = 'open', reopened_at = now(), reopened_by_staff_user_id = ${staffId},
      reopened_reason = 'Koreksi biaya Shopee yang terlambat' where month = ${month}`;
}

/** A promise and its resolver: holds a transaction open until the test lets it go. */
function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Waits until another backend in this database is blocked on a lock while running a statement
 * containing `fragment`. Replaces sleeps: the test proceeds exactly when the wait is real, and
 * fails loudly (instead of passing vacuously) if it never happens. */
async function waitUntilBlocked(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await client`
      select 1 from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like ${`%${fragment}%`}`;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no statement containing "${fragment}" was blocked on a lock within 5 s`);
}

/** Starts a query or transaction now without awaiting it, and keeps its rejection from being
 * reported as unhandled before the test awaits it. */
function started<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 4, onnotice: () => {} });
  migrationsDir = migrationsUpTo(Number.MAX_SAFE_INTEGER);
  await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  const [ownerRole] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${ownerRole!.id}) returning id`;
  staffId = staff!.id as string;
});

afterAll(async () => {
  await client?.end();
  rmSync(migrationsDir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("balance (deferred to commit)", () => {
  test("a balanced entry with two or more lines commits", async () => {
    const id = await post({
      date: "2027-01-10",
      lines: [
        { account: "1-1201", debit: 750_000 },
        { account: "1-1101", debit: 250_000 },
        { account: "3-1001", credit: 1_000_000 },
      ],
    });
    const [{ count }] = (await client`select count(*)::int as count from journal_lines where entry_id = ${id}`) as unknown as [{ count: number }];
    expect(count).toBe(3);
  });

  test("an unbalanced entry is refused at commit", async () => {
    await expect(
      post({ date: "2027-01-10", lines: [{ account: "1-1201", debit: 1_000_000 }, { account: "3-1001", credit: 999_999 }] }),
    ).rejects.toThrow(/does not balance/);
  });

  test("a one-line entry and an entry with no lines are refused at commit", async () => {
    await expect(post({ date: "2027-01-10", lines: [{ account: "1-1201", debit: 1 }] })).rejects.toThrow(/does not balance/);
    await expect(post({ date: "2027-01-10", lines: [] })).rejects.toThrow(/does not balance/);
  });

  test("a line has exactly one positive side, never negative", async () => {
    for (const line of [
      { account: "1-1201", debit: 0, credit: 0 },
      { account: "1-1201", debit: 5, credit: 5 },
      { account: "1-1201", debit: -5 },
    ]) {
      await expect(post({ date: "2027-01-10", lines: [line, { account: "3-1001", credit: 5 }] })).rejects.toThrow(/journal_lines_amount_check/);
    }
  });

  test("nothing is left behind by a refused entry", async () => {
    const [{ count }] = (await client`
      select count(*)::int as count from journal_entries e
      where not exists (select 1 from journal_lines l where l.entry_id = e.id)`) as unknown as [{ count: number }];
    expect(count).toBe(0);
  });
});

describe("append-only journals", () => {
  test("lines are never updated or deleted; entries are never deleted or edited", async () => {
    const id = await post(balanced());
    await expect(client`update journal_lines set debit = 2000000 where entry_id = ${id} and line_no = 1`).rejects.toThrow(/append-only/);
    await expect(client`delete from journal_lines where entry_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(client`delete from journal_entries where id = ${id}`).rejects.toThrow(/never deleted/);
    await expect(client`update journal_entries set description = 'Diubah' where id = ${id}`).rejects.toThrow(/only reversed_by_entry_id/);
    await expect(client`update journal_entries set entry_date = '2027-01-20' where id = ${id}`).rejects.toThrow(/only reversed_by_entry_id/);
  });

  test("a line can only join its entry in the transaction that created it", async () => {
    const id = await post(balanced());
    await expect(
      client.begin(async (tx) => {
        await tx`insert into journal_lines (entry_id, line_no, account_code, debit) values (${id}, 3, '1-1101', 10)`;
        await tx`insert into journal_lines (entry_id, line_no, account_code, credit) values (${id}, 4, '3-1001', 10)`;
      }),
    ).rejects.toThrow(/only added in the transaction that created entry/);
  });

  test("an explicit created_at is overwritten with the transaction start, so it cannot fake the same transaction", async () => {
    let id = "";
    await client.begin(async (tx) => {
      entryCounter += 1;
      const [row] = await tx`
        insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id, created_at)
        values (${`JU-202701-${String(entryCounter).padStart(4, "0")}`}, '2027-01-15', 'manual', 'x', ${staffId}, '2000-01-01')
        returning id`;
      id = row!.id as string;
      await tx`insert into journal_lines (entry_id, line_no, account_code, debit) values (${id}, 1, '1-1201', 10)`;
      await tx`insert into journal_lines (entry_id, line_no, account_code, credit) values (${id}, 2, '3-1001', 10)`;
    });
    const [entry] = await client`select created_at from journal_entries where id = ${id}`;
    expect(new Date(entry!.created_at as string).getUTCFullYear()).toBeGreaterThan(2000);
  });

  test("reversal: the stamp is set once, only to the entry's own reversal, and a reversal is never reversed", async () => {
    const id = await post(balanced());
    const other = await post(balanced());
    const reversalId = await reverse(id, "2027-01-16");
    const [stamped] = await client`select reversed_by_entry_id from journal_entries where id = ${id}`;
    expect(stamped!.reversed_by_entry_id).toBe(reversalId);
    // Twice, or to something else: refused.
    await expect(client`update journal_entries set reversed_by_entry_id = ${other} where id = ${id}`).rejects.toThrow(/only reversed_by_entry_id/);
    await expect(client`update journal_entries set reversed_by_entry_id = ${reversalId} where id = ${other}`).rejects.toThrow(/must be the entry that reverses it/);
    // A second reversal of the same entry.
    await expect(reverse(id, "2027-01-17")).rejects.toThrow(/journal_entries_reverses_entry_id_unique/);
    // Reversing a reversal.
    await expect(reverse(reversalId, "2027-01-17")).rejects.toThrow(/a reversal is never reversed/);
    // The stamp can't be set on insert.
    await expect(
      client.begin(async (tx) => {
        entryCounter += 1;
        await tx`
          insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id, reversed_by_entry_id)
          values (${`JU-202701-${String(entryCounter).padStart(4, "0")}`}, '2027-01-15', 'manual', 'x', ${staffId}, ${reversalId})`;
      }),
    ).rejects.toThrow(/stamped when the reversal is inserted/);
  });

  test("a reversal whose target is not stamped by commit is refused", async () => {
    const id = await post(balanced());
    await expect(
      client.begin(async (tx) => {
        await insertEntry(tx, {
          date: "2027-01-16",
          kind: "reversal",
          reverses: id,
          lines: [
            { account: "3-1001", debit: 1_000_000 },
            { account: "1-1201", credit: 1_000_000 },
          ],
        });
      }),
    ).rejects.toThrow(/must be stamped with reversed_by_entry_id/);
  });

  test("a reversal must mirror its target line for line: accounts, amounts and dimensions, sides swapped", async () => {
    const original = await post({
      date: "2027-01-15",
      lines: [
        { account: "1-1302", debit: 400_000, channel: "shopee" },
        { account: "4-1102", credit: 400_000, channel: "shopee" },
      ],
    });
    const attempt = (lines: LineInput[]) =>
      client.begin(async (tx) => {
        const id = await insertEntry(tx, { date: "2027-01-16", kind: "reversal", reverses: original, lines });
        await tx`update journal_entries set reversed_by_entry_id = ${id} where id = ${original}`;
      });
    const mirror: LineInput[] = [
      { account: "4-1102", debit: 400_000, channel: "shopee" },
      { account: "1-1302", credit: 400_000, channel: "shopee" },
    ];
    // Balanced, but not the mirror: a different amount, a different account, an extra pair of
    // lines, a dropped dimension, sides not swapped.
    for (const lines of [
      [
        { account: "4-1102", debit: 300_000, channel: "shopee" },
        { account: "1-1302", credit: 300_000, channel: "shopee" },
      ],
      [
        { account: "4-1101", debit: 400_000, channel: "shopee" },
        { account: "1-1302", credit: 400_000, channel: "shopee" },
      ],
      [...mirror, { account: "1-1201", debit: 5 }, { account: "3-1001", credit: 5 }],
      [{ account: "4-1102", debit: 400_000 }, { account: "1-1302", credit: 400_000, channel: "shopee" }],
      [
        { account: "1-1302", debit: 400_000, channel: "shopee" },
        { account: "4-1102", credit: 400_000, channel: "shopee" },
      ],
    ]) {
      await expect(attempt(lines)).rejects.toThrow(/must mirror entry/);
    }
    // Nothing was stamped by the refused attempts; the true mirror is accepted.
    const [before] = await client`select reversed_by_entry_id from journal_entries where id = ${original}`;
    expect(before!.reversed_by_entry_id).toBeNull();
    await attempt(mirror);
  });

  test("one active journal per posting key; after a reversal the key can be posted again", async () => {
    const source = { type: "business_expense", id: randomUUID(), event: "paid" };
    const entry = (amount: number): EntryInput => ({
      date: "2027-01-12",
      source,
      lines: [
        { account: "6-2101", debit: amount },
        { account: "1-1201", credit: amount },
      ],
    });
    const first = await post(entry(500_000));
    await expect(post(entry(500_000))).rejects.toThrow(/journal_entries_active_source_key/);
    await reverse(first, "2027-01-13");
    await post(entry(450_000));
    const active = await client`
      select id from journal_entries
      where source_type = ${source.type} and source_id = ${source.id} and source_event = ${source.event}
        and reversed_by_entry_id is null and kind <> 'reversal'`;
    expect(active).toHaveLength(1);
  });

  test("a system journal names its source and rule version; manual and opening journals name their author", async () => {
    await expect(
      client.begin(async (tx) => {
        entryCounter += 1;
        await tx`
          insert into journal_entries (entry_no, entry_date, kind, description)
          values (${`JU-202701-${String(entryCounter).padStart(4, "0")}`}, '2027-01-15', 'system', 'x')`;
      }),
    ).rejects.toThrow(/journal_entries_system_source_check/);
    await expect(
      client.begin(async (tx) => {
        entryCounter += 1;
        await tx`
          insert into journal_entries (entry_no, entry_date, kind, description)
          values (${`JU-202701-${String(entryCounter).padStart(4, "0")}`}, '2027-01-15', 'opening', 'Saldo awal')`;
      }),
    ).rejects.toThrow(/journal_entries_manual_actor_check/);
  });
});

describe("postable accounts", () => {
  test("a header account, an inactive account or an unknown code cannot be posted to", async () => {
    await expect(post({ date: "2027-01-15", lines: [{ account: "1-1500", debit: 10 }, { account: "3-1001", credit: 10 }] })).rejects.toThrow(
      /header or inactive/,
    );
    await client`insert into accounts (code, name, type, normal_balance, parent_code) values ('1-1202', 'Bank lama', 'asset', 'debit', '1-1200')`;
    await client`update accounts set is_active = false where code = '1-1202'`;
    await expect(post({ date: "2027-01-15", lines: [{ account: "1-1202", debit: 10 }, { account: "3-1001", credit: 10 }] })).rejects.toThrow(
      /header or inactive/,
    );
    await expect(
      post({ date: "2027-01-15", lines: [{ account: "1-1201", debit: 10, cashAccount: "1-1200" }, { account: "3-1001", credit: 10 }] }),
    ).rejects.toThrow(/cash account 1-1200 is a header or inactive/);
    await expect(post({ date: "2027-01-15", lines: [{ account: "1-9999", debit: 10 }, { account: "3-1001", credit: 10 }] })).rejects.toThrow(
      /journal_lines_account_code_accounts_code_fk/,
    );
  });
});

describe("isolation level", () => {
  test("journals are refused under REPEATABLE READ and SERIALIZABLE, whose snapshot could miss a just-committed close", async () => {
    for (const level of ["repeatable read", "serializable"]) {
      await expect(client.begin(`isolation level ${level}`, async (tx) => insertEntry(tx, balanced()))).rejects.toThrow(
        /only at READ COMMITTED isolation/,
      );
    }
    // The default (and an explicit READ COMMITTED) still posts.
    await client.begin("isolation level read committed", async (tx) => insertEntry(tx, balanced()));
  });
});

describe("closed periods (D-23) and the trial month (D-22)", () => {
  test("nothing is posted into a closed month; a correction goes to the first open month; reopening needs a written reason", async () => {
    await post(balanced("2027-02-05"));
    await closeMonth("2027-02-01");
    await expect(post(balanced("2027-02-28"))).rejects.toThrow(/accounting period 2027-02 is closed/);
    await expect(post(balanced("2027-02-01"))).rejects.toThrow(/accounting period 2027-02 is closed/);
    // The month around it is unaffected.
    await post(balanced("2027-03-01"));
    await post(balanced("2027-01-31"));
    // Reopen without a reason, or with a blank one: refused (the reopen trigger answers first; the
    // stamp CHECK is the backstop for the same rule).
    await expect(
      client`update fiscal_periods set status = 'open', reopened_at = now(), reopened_by_staff_user_id = ${staffId} where month = '2027-02-01'`,
    ).rejects.toThrow(/reopening needs/);
    await expect(
      client`update fiscal_periods set status = 'open', reopened_at = now(), reopened_by_staff_user_id = ${staffId}, reopened_reason = '  ' where month = '2027-02-01'`,
    ).rejects.toThrow(/reopening needs/);
    // The CHECK alone: a reason with no who/when, on a month that was never closed.
    await expect(client`insert into fiscal_periods (month, reopened_reason) values ('2027-10-01', 'Alasan')`).rejects.toThrow(
      /fiscal_periods_reopen_stamp_check/,
    );
    // A plain status change with no stamp at all: refused (the CHECK alone allowed it).
    await expect(client`update fiscal_periods set status = 'open' where month = '2027-02-01'`).rejects.toThrow(/reopening needs/);
    await reopenMonth("2027-02-01");
    await post(balanced("2027-02-28"));
    // Closed again, then reopened keeping the previous reopen's stamp and reason: refused.
    await closeMonth("2027-02-01");
    await expect(client`update fiscal_periods set status = 'open' where month = '2027-02-01'`).rejects.toThrow(/reopening needs/);
    await client`update fiscal_periods set status = 'open', reopened_at = now(), reopened_by_staff_user_id = ${staffId},
      reopened_reason = 'Retur Shopee November masuk terlambat' where month = '2027-02-01'`;
    const [period] = await client`select status, reopened_reason from fiscal_periods where month = '2027-02-01'`;
    expect(period).toMatchObject({ status: "open", reopened_reason: "Retur Shopee November masuk terlambat" });
  });

  test("a reversal of a closed month's entry is dated in an open month; the stamp on the closed entry is still allowed", async () => {
    const id = await post(balanced("2027-04-10"));
    await closeMonth("2027-04-01");
    await expect(reverse(id, "2027-04-30")).rejects.toThrow(/accounting period 2027-04 is closed/);
    await reverse(id, "2027-05-01");
  });

  test("a closed month needs its close stamp; months are first days; the trial month is never closed; periods are never deleted", async () => {
    await expect(client`insert into fiscal_periods (month, status) values ('2027-06-01', 'closed')`).rejects.toThrow(/fiscal_periods_closed_stamp_check/);
    await expect(client`insert into fiscal_periods (month) values ('2027-06-15')`).rejects.toThrow(/fiscal_periods_month_check/);
    await expect(closeMonth("2026-12-01")).rejects.toThrow(/fiscal_periods_trial_month_open_check/);
    await post(balanced("2026-12-20"));
    await client`insert into fiscal_periods (month) values ('2027-07-01')`;
    await expect(client`update fiscal_periods set month = '2027-08-01' where month = '2027-07-01'`).rejects.toThrow(/month is immutable/);
    await expect(client`delete from fiscal_periods where month = '2027-07-01'`).rejects.toThrow(/never deleted/);
  });

  test("a close waits for an in-flight post to the same month, and the next post sees the close", async () => {
    const posted = barrier();
    const hold = barrier();
    const posting = started(
      client.begin(async (tx) => {
        await insertEntry(tx, balanced("2027-09-10"));
        posted.release();
        // Keep the month's shared lock until the close is seen waiting for it.
        await hold.promise;
      }),
    );
    await posted.promise;
    const closing = started(closeMonth("2027-09-01"));
    await waitUntilBlocked("fiscal_periods");
    hold.release();
    await posting;
    await closing;
    const [{ count }] = (await client`
      select count(*)::int as count from journal_entries where entry_date between '2027-09-01' and '2027-09-30'`) as unknown as [{ count: number }];
    expect(count).toBe(1);
    await expect(post(balanced("2027-09-11"))).rejects.toThrow(/accounting period 2027-09 is closed/);
  });
});

describe("accounts and mappings", () => {
  test("a system account is renamed and gets sibling sub-accounts, but its identity never changes and it is never deactivated or deleted", async () => {
    await client`update accounts set name = 'Kas kecil toko' where code = '1-1101'`;
    // Since 0051 a parent is always a header (plan §8.1), so a second cash account goes under the
    // Kas header beside Kas tunai, not under the postable system account itself.
    await client`insert into accounts (code, name, type, normal_balance, parent_code) values ('1-1102', 'Kas gudang', 'asset', 'debit', '1-1100')`;
    for (const change of [
      client`update accounts set code = '1-1199' where code = '1-1102'`,
      client`update accounts set type = 'expense' where code = '1-1501'`,
      client`update accounts set normal_balance = 'credit' where code = '1-1501'`,
      client`update accounts set system_key = 'inventory.cloth' where code = '1-1501'`,
      client`update accounts set is_system = false, system_key = null where code = '1-1501'`,
      client`update accounts set is_system = true, system_key = 'cash.warehouse' where code = '1-1102'`,
    ]) {
      await expect(change).rejects.toThrow(/immutable/);
    }
    await expect(client`update accounts set is_active = false where code = '1-1501'`).rejects.toThrow(/accounts_system_active_check/);
    await expect(client`delete from accounts where code = '1-1501'`).rejects.toThrow(/system accounts are never deleted/);
  });

  test("an account with lines is never deleted and never becomes a header; an unused one may be deleted", async () => {
    await client`insert into accounts (code, name, type, normal_balance) values ('7-1104', 'Pendapatan sewa alat', 'other_income', 'credit')`;
    await post({ date: "2027-01-20", lines: [{ account: "1-1201", debit: 10_000 }, { account: "7-1104", credit: 10_000 }] });
    await expect(client`delete from accounts where code = '7-1104'`).rejects.toThrow(/journal lines is never deleted/);
    await expect(client`update accounts set is_header = true where code = '7-1104'`).rejects.toThrow(/cannot become a header/);
    await client`update accounts set is_active = false where code = '7-1104'`;
    await client`insert into accounts (code, name, type, normal_balance) values ('7-1105', 'Belum dipakai', 'other_income', 'credit')`;
    await client`delete from accounts where code = '7-1105'`;
  });

  test("account rows: code format, parent cycle, system key only with is_system, bank fields", async () => {
    const insert = (code: string, extra: Partial<Record<"parent_code" | "system_key" | "account_no_last4", string>> = {}, isSystem = false) =>
      client`
        insert into accounts (code, name, type, normal_balance, parent_code, is_system, system_key, account_no_last4)
        values (${code}, ${`Akun ${code}`}, 'asset', 'debit', ${extra.parent_code ?? null}, ${isSystem}, ${extra.system_key ?? null}, ${extra.account_no_last4 ?? null})`;
    await expect(insert("11501")).rejects.toThrow(/accounts_code_check/);
    await expect(insert("1-150")).rejects.toThrow(/accounts_code_check/);
    await expect(insert("1-1409", {})).rejects.toThrow(/accounts_pkey/);
    await expect(insert("1-1408", { system_key: "receivable.other" })).rejects.toThrow(/accounts_system_key_check/);
    await expect(insert("1-1408", { account_no_last4: "12a4" })).rejects.toThrow(/accounts_account_no_last4_check/);
    // The cycle trigger (BEFORE INSERT) refuses a self-parent before the CHECK sees it; both refuse.
    await expect(insert("1-1408", { parent_code: "1-1408" })).rejects.toThrow(/would make a cycle/);
    await expect(client`update accounts set parent_code = '1-1500' where code = '1-1000'`).rejects.toThrow(/would make a cycle/);
    await expect(
      client`insert into accounts (code, name, type, normal_balance) values ('1-1407', 'persediaan BAHAN kain', 'asset', 'debit')`,
    ).rejects.toThrow(/accounts_name_unique/);
  });

  test("a mapping points at an active, postable account; a mapped account cannot be deactivated", async () => {
    await expect(client`update account_mappings set account_code = '6-1000' where mapping_key = 'expense.category.rent'`).rejects.toThrow(
      /must be active and not a header/,
    );
    await expect(client`insert into account_mappings (mapping_key, account_code) values ('expense.category.bank_fee', '1-1202')`).rejects.toThrow(
      /must be active and not a header/,
    );
    await expect(client`insert into account_mappings (mapping_key, account_code) values ('Expense', '8-1101')`).rejects.toThrow(/account_mappings_key_check/);
    await client`insert into account_mappings (mapping_key, account_code) values ('expense.category.bank_fee', '8-1101')`;
    await expect(client`update accounts set is_active = false where code = '8-1101'`).rejects.toThrow(/mapping points at/);
    await expect(client`delete from accounts where code = '8-1101'`).rejects.toThrow(/account_mappings_account_code_accounts_code_fk/);
  });
});

describe("account checks hold under concurrent writes (no check-then-write)", () => {
  test("making an account a header waits for an in-flight line on it, then sees the line and is refused", async () => {
    await client`insert into accounts (code, name, type, normal_balance) values ('7-1106', 'Pendapatan uji header', 'other_income', 'credit')`;
    const posted = barrier();
    const hold = barrier();
    const posting = started(
      client.begin(async (tx) => {
        await insertEntry(tx, { date: "2027-01-21", lines: [{ account: "1-1201", debit: 1_000 }, { account: "7-1106", credit: 1_000 }] });
        posted.release();
        await hold.promise;
      }),
    );
    await posted.promise;
    const makeHeader = started(client`update accounts set is_header = true where code = '7-1106'`);
    await waitUntilBlocked("is_header");
    hold.release();
    await posting;
    await expect(makeHeader).rejects.toThrow(/cannot become a header/);
  });

  test("a line waits for an in-flight deactivation of its account, then sees it and is refused", async () => {
    await client`insert into accounts (code, name, type, normal_balance) values ('7-1107', 'Pendapatan uji nonaktif', 'other_income', 'credit')`;
    const updated = barrier();
    const hold = barrier();
    const deactivating = started(
      client.begin(async (tx) => {
        await tx`update accounts set is_active = false where code = '7-1107'`;
        updated.release();
        await hold.promise;
      }),
    );
    await updated.promise;
    const posting = started(post({ date: "2027-01-21", lines: [{ account: "1-1201", debit: 1_000 }, { account: "7-1107", credit: 1_000 }] }));
    await waitUntilBlocked("journal_lines");
    hold.release();
    await deactivating;
    await expect(posting).rejects.toThrow(/header or inactive/);
  });

  test("a mapping waits for an in-flight deactivation of its target, then sees it and is refused; and the other way round", async () => {
    await client`insert into accounts (code, name, type, normal_balance) values ('8-1103', 'Beban uji pemetaan', 'other_expense', 'debit')`;
    const updated = barrier();
    const hold = barrier();
    const deactivating = started(
      client.begin(async (tx) => {
        await tx`update accounts set is_active = false where code = '8-1103'`;
        updated.release();
        await hold.promise;
      }),
    );
    await updated.promise;
    const mapping = started(client`insert into account_mappings (mapping_key, account_code) values ('expense.category.uji_satu', '8-1103')`);
    await waitUntilBlocked("account_mappings");
    hold.release();
    await deactivating;
    await expect(mapping).rejects.toThrow(/must be active and not a header/);

    // Mapping first: the deactivation waits for it, then sees the mapping and is refused.
    await client`update accounts set is_active = true where code = '8-1103'`;
    const mapped = barrier();
    const holdMapping = barrier();
    const mappingTx = started(
      client.begin(async (tx) => {
        await tx`insert into account_mappings (mapping_key, account_code) values ('expense.category.uji_dua', '8-1103')`;
        mapped.release();
        await holdMapping.promise;
      }),
    );
    await mapped.promise;
    const deactivate = started(client`update accounts set is_active = false where code = '8-1103'`);
    await waitUntilBlocked("is_active");
    holdMapping.release();
    await mappingTx;
    await expect(deactivate).rejects.toThrow(/mapping points at/);
  });
});

describe("D-14 guard: fabric and material purchases never post to an expense account", () => {
  const expenseAccountByType: Record<(typeof EXPENSE_LIKE_ACCOUNT_TYPES)[number], string> = {
    expense: "6-3101", // Ongkir bahan: the most tempting wrong target for a fabric purchase
    cogs: "5-1101",
    other_expense: "8-1101",
    tax: "9-1101",
  };

  test("the purchase-side entries the plan names post fine to inventory, utang, advances and cash", async () => {
    // P1: fabric receipt Dr Persediaan bahan kain / Cr Uang muka pembelian + Utang usaha pemasok bahan.
    await post({
      date: "2027-01-08",
      source: { type: "goods_receipt_item", event: "received" },
      lines: [
        { account: "1-1501", debit: 3_000_000 },
        { account: "1-1506", debit: 150_000 },
        { account: "1-1601", credit: 1_000_000 },
        { account: "2-1101", credit: 2_150_000 },
      ],
    });
    // P3: supplier payment Dr Utang / Cr Bank.
    await post({
      date: "2027-01-09",
      source: { type: "supplier_payment", event: "paid" },
      lines: [
        { account: "2-1101", debit: 2_150_000 },
        { account: "1-1201", credit: 2_150_000 },
      ],
    });
    // R1: batch posted Dr WIP / Cr fabric, accessories, utang jasa produksi.
    await post({
      date: "2027-01-10",
      source: { type: "production_batch", event: "posted" },
      lines: [
        { account: "1-1503", debit: 4_000_000 },
        { account: "1-1501", credit: 3_000_000 },
        { account: "1-1502", credit: 200_000 },
        { account: "2-1102", credit: 800_000 },
      ],
    });
  });

  for (const source of PURCHASE_SIDE_JOURNAL_SOURCES) {
    for (const [type, account] of Object.entries(expenseAccountByType)) {
      test(`${source.sourceType}${source.event ? `/${source.event}` : ""} → ${type} account ${account} is refused`, async () => {
        const error = await post({
          date: "2027-01-08",
          source: { type: source.sourceType, event: source.event ?? "received" },
          lines: [
            { account, debit: 500_000 },
            { account: "2-1101", credit: 500_000 },
          ],
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: "23514", constraint_name: "journal_lines_purchase_guard" });
        expect(String((error as Error).message)).toMatch(/can never post to/);
      });
    }
  }

  test("a fabric purchase booked as Dr Ongkir bahan / Cr Bank via a supplier payment is refused, credit side too", async () => {
    await expect(
      post({
        date: "2027-01-09",
        source: { type: "supplier_payment", event: "paid" },
        lines: [
          { account: "1-1201", debit: 100_000 },
          { account: "6-3101", credit: 100_000 },
        ],
      }),
    ).rejects.toThrow(/journal_lines_purchase_guard|can never post to/);
  });

  test("an expense account the accountant adds later is caught by its type, not its code", async () => {
    await client`insert into accounts (code, name, type, normal_balance, parent_code) values ('6-3102', 'Biaya bahan lain', 'expense', 'debit', null)`;
    await expect(
      post({
        date: "2027-01-08",
        source: { type: "goods_receipt_item", event: "received" },
        lines: [
          { account: "6-3102", debit: 10_000 },
          { account: "2-1101", credit: 10_000 },
        ],
      }),
    ).rejects.toThrow(/can never post to expense account 6-3102/);
  });

  test("a reversal of a purchase-side journal is held to the same rule", async () => {
    const receipt = await post({
      date: "2027-01-08",
      source: { type: "goods_receipt_item", event: "received" },
      lines: [
        { account: "1-1502", debit: 75_000 },
        { account: "2-1101", credit: 75_000 },
      ],
    });
    await expect(
      client.begin(async (tx) => {
        const [original] = await tx`select source_id from journal_entries where id = ${receipt}`;
        const id = await insertEntry(tx, {
          date: "2027-01-09",
          kind: "reversal",
          reverses: receipt,
          source: { type: "goods_receipt_item", id: original!.source_id as string, event: "received" },
          lines: [
            { account: "2-1101", debit: 75_000 },
            { account: "6-4102", credit: 75_000 },
          ],
        });
        await tx`update journal_entries set reversed_by_entry_id = ${id} where id = ${receipt}`;
      }),
    ).rejects.toThrow(/can never post to/);
  });

  test("decided exceptions still post: R3 WIP close (D-15), P7 raw-material count variance (D-16), A2 defect disposal (D-7), and ordinary expenses", async () => {
    await post({
      date: "2027-01-20",
      source: { type: "production_batch", event: "wip_close" },
      lines: [
        { account: "6-4102", debit: 120_000 },
        { account: "1-1503", credit: 120_000 },
      ],
    });
    await post({
      date: "2027-01-20",
      source: { type: "fabric_stock_movement", event: "adjustment" },
      lines: [
        { account: "6-4101", debit: 40_000 },
        { account: "1-1501", credit: 40_000 },
      ],
    });
    await post({
      date: "2027-01-20",
      source: { type: "defect_movement", event: "dispose" },
      lines: [
        { account: "6-4103", debit: 90_000 },
        { account: "1-1506", credit: 90_000 },
      ],
    });
    await post({
      date: "2027-01-20",
      source: { type: "business_expense", event: "paid" },
      lines: [
        { account: "6-3101", debit: 25_000 },
        { account: "1-1101", credit: 25_000 },
      ],
    });
  });
});

describe("tax_settings (D-20)", () => {
  test("rate in basis points, non-negative exemption, end date on or after the start, months only", async () => {
    const insert = (effectiveFrom: string, rateBps: number, exemption: number, validUntil: string | null) =>
      client`
        insert into tax_settings (effective_from, taxpayer_type, taxpayer_label, npwp_registered_year, rate_bps, annual_exemption_amount, rate_valid_until)
        values (${effectiveFrom}, 'individual', 'Istri pemilik, orang pribadi', 2020, ${rateBps}, ${exemption}, ${validUntil})`;
    await expect(insert("2027-01-01", -1, 500_000_000, null)).rejects.toThrow(/tax_settings_rate_bps_check/);
    await expect(insert("2027-01-01", 10_001, 500_000_000, null)).rejects.toThrow(/tax_settings_rate_bps_check/);
    await expect(insert("2027-01-01", 50, -1, null)).rejects.toThrow(/tax_settings_exemption_check/);
    await expect(insert("2027-01-01", 50, 500_000_000, "2026-12-31")).rejects.toThrow(/tax_settings_valid_until_check/);
    await expect(insert("2027-01-15", 50, 500_000_000, null)).rejects.toThrow(/tax_settings_effective_from_check/);
    await insert("2027-01-01", 50, 500_000_000, "2029-12-31");
    await client`update tax_settings set rate_valid_until = null, updated_by_staff_user_id = ${staffId} where effective_from = '2027-01-01'`;
  });
});
