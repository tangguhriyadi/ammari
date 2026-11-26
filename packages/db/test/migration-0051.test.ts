import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seed } from "../src/seed";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0051 (Akuntansi Session 3: Data Master Akun + Pemetaan akun; docs/plans/accounting.md
// §8 and the §8.1 items carried to Session 3). Upgrades a 0050 database that already holds an
// accountant's own sub-account, a re-mapping and a posted journal, then proves against the real
// triggers and CHECKs:
//   - an account code's leading digit fixes its type; bank fields only on postable Kas & Bank;
//   - the tree: a parent is a header of the same type, a header with sub-accounts stays one, no
//     cycle, and two concurrent tree changes serialise (the 0049 cycle check could race);
//   - an account a mapping points at never becomes a header;
//   - mapping targets by key family: an expense never onto inventory 1-15xx (D-14), methods onto
//     Kas & Bank (D-17/D-18), channels onto revenue, supplier payables onto liabilities;
//   - seed.ts re-runs on a database where a default key was re-mapped and its old target
//     deactivated (the BEFORE INSERT guard used to fire before ON CONFLICT DO NOTHING).
// The rules mirror packages/accounting/src/mapping-rules.ts (mapping-rules.test.ts).
//
// Commits for real and holds concurrent transactions, so it owns a disposable database.

const SCRATCH_DATABASE = "ammari_scratch_migration_0051";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0050: string;
let upTo0051: string;

/** A promise and its resolver: holds a transaction open until the test lets it go. */
function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Waits until another backend is blocked on a lock while running a statement containing
 * `fragment`; fails loudly if that never happens (no sleeps, no vacuous passes). */
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

function started<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

async function insertAccount(code: string, type: string, options: { parent?: string; header?: boolean; normal?: "debit" | "credit" } = {}) {
  await client`
    insert into accounts (code, name, type, normal_balance, parent_code, is_header)
    values (${code}, ${`Akun uji ${code}`}, ${type}, ${options.normal ?? "debit"}, ${options.parent ?? null}, ${options.header ?? false})`;
}

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 4, onnotice: () => {} });
  upTo0050 = migrationsUpTo(50);
  upTo0051 = migrationsUpTo(51);
  await migrate(drizzle(client), { migrationsFolder: upTo0050 });

  // What a 0050 database may already hold: an accountant's sub-account under Bank with its bank
  // fields, a re-mapped category and a posted journal on the new account.
  await client`
    insert into accounts (code, name, type, normal_balance, parent_code, bank_name, account_no_last4, cash_flow_group)
    values ('1-1202', 'Bank cadangan', 'asset', 'debit', '1-1200', 'BRI', '4321', 'cash')`;
  await client`update account_mappings set account_code = '6-2901' where mapping_key = 'expense.category.packaging'`;
  const [role] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
  await client.begin(async (tx) => {
    const [entry] = await tx`
      insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id)
      values ('JU-202701-0001', '2027-01-05', 'opening', 'Saldo awal uji', ${staff!.id}) returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_code, debit, credit) values (${entry!.id}, 1, '1-1202', 250000, 0)`;
    await tx`insert into journal_lines (entry_id, line_no, account_code, debit, credit) values (${entry!.id}, 2, '3-9001', 0, 250000)`;
  });

  await migrate(drizzle(client), { migrationsFolder: upTo0051 });
});

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0050, upTo0051]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("upgrade from 0050", () => {
  test("existing rows keep working: every constraint is validated, the sub-account, mapping and journal are untouched", async () => {
    const [{ invalid }] = (await client`select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
    expect(invalid).toBe(0);
    const names = await client`select conname from pg_constraint where conrelid = 'accounts'::regclass and conname in ('accounts_code_type_check', 'accounts_bank_fields_cash_bank_check') order by 1`;
    expect(names.map((row) => row.conname)).toEqual(["accounts_bank_fields_cash_bank_check", "accounts_code_type_check"]);
    expect(await client`select tgname from pg_trigger where tgrelid = 'accounts'::regclass and tgname = 'accounts_parent_no_cycle'`).toHaveLength(0);
    const [bank] = await client`select bank_name, account_no_last4 from accounts where code = '1-1202'`;
    expect(bank).toEqual({ bank_name: "BRI", account_no_last4: "4321" });
    const [mapping] = await client`select account_code from account_mappings where mapping_key = 'expense.category.packaging'`;
    expect(mapping!.account_code).toBe("6-2901");
    const [{ count }] = (await client`select count(*)::int as count from journal_lines where account_code = '1-1202'`) as unknown as [{ count: number }];
    expect(count).toBe(1);
  });
});

describe("account rows", () => {
  test("an account code's leading digit fixes its type (no 6-xxxx asset)", async () => {
    await expect(insertAccount("6-5101", "asset")).rejects.toThrow(/accounts_code_type_check/);
    await expect(insertAccount("1-1702", "expense")).rejects.toThrow(/accounts_code_type_check/);
    await expect(insertAccount("4-1105", "expense")).rejects.toThrow(/accounts_code_type_check/);
    await insertAccount("4-1401", "contra_revenue");
    await insertAccount("8-1104", "other_expense");
  });

  test("bank fields only on a postable Kas & Bank account (1-11xx, 1-12xx)", async () => {
    await expect(client`update accounts set bank_name = 'BCA' where code = '1-1301'`).rejects.toThrow(/accounts_bank_fields_cash_bank_check/);
    await expect(client`update accounts set account_no_last4 = '1234' where code = '6-2101'`).rejects.toThrow(/accounts_bank_fields_cash_bank_check/);
    await expect(client`update accounts set bank_name = 'BCA' where code = '1-1200'`).rejects.toThrow(/accounts_bank_fields_cash_bank_check/);
    await client`update accounts set bank_name = 'BCA', account_no_last4 = '9876' where code = '1-1201'`;
    await client`update accounts set bank_name = null, account_no_last4 = null where code = '1-1201'`;
  });
});

describe("the account tree (plan §8.1)", () => {
  test("a parent is a header: a postable account, system or not, gets no sub-accounts; a second bank goes under the Bank header", async () => {
    await expect(insertAccount("1-1102", "asset", { parent: "1-1101" })).rejects.toThrow(/must be a header/);
    await expect(insertAccount("7-1108", "other_income", { parent: "7-1102" })).rejects.toThrow(/must be a header/);
    await insertAccount("1-1203", "asset", { parent: "1-1200" });
    await expect(client`update accounts set parent_code = '1-1201' where code = '1-1203'`).rejects.toThrow(/must be a header/);
  });

  test("a sub-account has its parent's type", async () => {
    await expect(insertAccount("4-1202", "contra_revenue", { parent: "4-1100" })).rejects.toThrow(/parent's type/);
    await insertAccount("4-1106", "revenue", { parent: "4-1100", normal: "credit" });
  });

  test("a header with sub-accounts stays a header; one without may become postable", async () => {
    await expect(client`update accounts set is_header = false where code = '1-1200'`).rejects.toThrow(/stays a header/);
    await insertAccount("6-5000", "expense", { header: true });
    await client`update accounts set is_header = false where code = '6-5000'`;
  });

  test("no cycle; the self-parent is refused by the trigger before the CHECK", async () => {
    await insertAccount("6-6000", "expense", { header: true });
    await insertAccount("6-6100", "expense", { header: true, parent: "6-6000" });
    await expect(client`update accounts set parent_code = '6-6100' where code = '6-6000'`).rejects.toThrow(/would make a cycle/);
    await expect(insertAccount("6-6200", "expense", { header: true, parent: "6-6200" })).rejects.toThrow(/would make a cycle/);
  });

  test("an account a mapping points at never becomes a header; nor does one with journal lines", async () => {
    await expect(client`update accounts set is_header = true where code = '6-2901'`).rejects.toThrow(/mapping points at cannot become a header/);
    await expect(client`update accounts set is_header = true where code = '1-1202'`).rejects.toThrow(/journal lines cannot become a header/);
  });

  test("two concurrent parent changes that together would form a cycle: the second waits, then sees the first and is refused", async () => {
    await insertAccount("6-7000", "expense", { header: true });
    await insertAccount("6-8000", "expense", { header: true });
    const moved = barrier();
    const hold = barrier();
    const first = started(
      client.begin(async (tx) => {
        await tx`update accounts set parent_code = '6-8000' where code = '6-7000'`;
        moved.release();
        await hold.promise;
      }),
    );
    await moved.promise;
    // Different rows, so no row lock is shared: only the tree lock makes the second wait.
    const second = started(client`update accounts set parent_code = '6-7000' where code = '6-8000'`);
    await waitUntilBlocked("parent_code = '6-7000'");
    hold.release();
    await first;
    await expect(second).rejects.toThrow(/would make a cycle/);
    const [row] = await client`select parent_code from accounts where code = '6-8000'`;
    expect(row!.parent_code).toBeNull();
  });

  test("a sub-account insert and its parent turning postable: the second waits, then sees the first and is refused", async () => {
    await insertAccount("6-9000", "expense", { header: true });
    const inserted = barrier();
    const hold = barrier();
    const insert = started(
      client.begin(async (tx) => {
        await tx`insert into accounts (code, name, type, normal_balance, parent_code) values ('6-9001', 'Sub uji', 'expense', 'debit', '6-9000')`;
        inserted.release();
        await hold.promise;
      }),
    );
    await inserted.promise;
    const unheader = started(client`update accounts set is_header = false where code = '6-9000'`);
    await waitUntilBlocked("is_header = false where code = '6-9000'");
    hold.release();
    await insert;
    await expect(unheader).rejects.toThrow(/stays a header/);
  });

  test("tree changes are refused outside READ COMMITTED (the reads would use an older snapshot)", async () => {
    await expect(
      client.begin("isolation level repeatable read", async (tx) => {
        await tx`insert into accounts (code, name, type, normal_balance, parent_code) values ('6-9002', 'Sub RR', 'expense', 'debit', '6-9000')`;
      }),
    ).rejects.toThrow(/READ COMMITTED/);
    // A rename or a root account touches no chain and is fine at any level.
    await client.begin("isolation level repeatable read", async (tx) => {
      await tx`update accounts set name = 'Header uji 9000' where code = '6-9000'`;
      await tx`insert into accounts (code, name, type, normal_balance) values ('6-9500', 'Root RR', 'expense', 'debit')`;
    });
  });
});

describe("mapping targets by key family", () => {
  test("D-14: an expense category or item is never mapped to an inventory account; other targets are fine", async () => {
    for (const code of ["1-1501", "1-1502", "1-1504"]) {
      await expect(client`update account_mappings set account_code = ${code} where mapping_key = 'expense.category.material_shipping'`).rejects.toThrow(
        /never mapped to inventory/,
      );
      await expect(
        client`insert into account_mappings (mapping_key, account_code) values ('expense.item.0b9d3c2e-1111-4222-8333-444455556666', ${code})`,
      ).rejects.toThrow(/never mapped to inventory/);
    }
    await client`insert into account_mappings (mapping_key, account_code) values ('expense.item.0b9d3c2e-1111-4222-8333-444455556666', '1-1603')`;
    await client`insert into account_mappings (mapping_key, account_code) values ('expense.category.tax_payment', '2-1401')`;
    const [row] = await client`select account_code from account_mappings where mapping_key = 'expense.category.material_shipping'`;
    expect(row!.account_code).toBe("6-3101");
  });

  test("payment methods and the Midtrans payout go to Kas & Bank only (D-17, D-18)", async () => {
    await expect(client`update account_mappings set account_code = '1-1301' where mapping_key = 'cash.method.transfer'`).rejects.toThrow(/cash or bank/);
    await expect(client`update account_mappings set account_code = '6-2101' where mapping_key = 'cash.midtrans_payout'`).rejects.toThrow(/cash or bank/);
    await client`update account_mappings set account_code = '1-1202' where mapping_key = 'cash.method.card'`;
    await client`update account_mappings set account_code = '1-1201' where mapping_key = 'cash.method.card'`;
  });

  test("a channel's sales go to a revenue account; a supplier payable to a liability", async () => {
    await expect(client`update account_mappings set account_code = '4-1201' where mapping_key = 'revenue.channel.web'`).rejects.toThrow(/revenue account/);
    await expect(client`update account_mappings set account_code = '6-3101' where mapping_key = 'supplier_payable.kind.material'`).rejects.toThrow(
      /liability account/,
    );
    await client`update account_mappings set account_code = '4-1106' where mapping_key = 'revenue.channel.offline'`;
  });

  test("an INSERT of an existing key is left to ON CONFLICT: DO NOTHING keeps the row, DO UPDATE re-checks the target, a plain INSERT hits the key", async () => {
    await client`insert into account_mappings (mapping_key, account_code) values ('expense.category.packaging', '1-1501') on conflict (mapping_key) do nothing`;
    const [kept] = await client`select account_code from account_mappings where mapping_key = 'expense.category.packaging'`;
    expect(kept!.account_code).toBe("6-2901");
    await expect(
      client`
        insert into account_mappings (mapping_key, account_code) values ('expense.category.packaging', '1-1501')
        on conflict (mapping_key) do update set account_code = excluded.account_code`,
    ).rejects.toThrow(/never mapped to inventory/);
    await expect(client`insert into account_mappings (mapping_key, account_code) values ('expense.category.packaging', '6-1401')`).rejects.toThrow(
      /account_mappings_pkey/,
    );
  });
});

describe("seed.ts on an edited database (plan §8.1)", () => {
  test("re-seeding after the accountant re-mapped a default key and deactivated its old target succeeds and keeps her choice", async () => {
    await client`update account_mappings set account_code = '6-2901' where mapping_key = 'expense.category.rent'`;
    await client`update accounts set is_active = false where code = '6-2201'`;
    await seed(drizzle(client));
    const [rent] = await client`select account_code from account_mappings where mapping_key = 'expense.category.rent'`;
    expect(rent!.account_code).toBe("6-2901");
    const [old] = await client`select is_active from accounts where code = '6-2201'`;
    expect(old!.is_active).toBe(false);
  });

  test("re-seeding after the accountant re-arranged headers (a seeded parent moved below its seeded child) keeps her tree", async () => {
    // Seeded: 1-1100 Kas under 1-1000 Aset lancar. She makes Kas a root and puts Aset lancar under it.
    // Re-inserting 1-1100 with its seeded parent 1-1000 would then look like a cycle; the INSERT of an
    // existing code is left to ON CONFLICT DO NOTHING instead of being validated.
    await client`update accounts set parent_code = null where code = '1-1100'`;
    await client`update accounts set parent_code = '1-1100' where code = '1-1000'`;
    await seed(drizzle(client));
    const rows = await client`select code, parent_code from accounts where code in ('1-1000', '1-1100') order by code`;
    expect(rows.map((row) => [row.code, row.parent_code])).toEqual([
      ["1-1000", "1-1100"],
      ["1-1100", null],
    ]);
  });
});
