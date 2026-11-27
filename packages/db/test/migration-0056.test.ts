import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0056 (Akuntansi Session 12, constraint hardening, docs/plans/accounting.md §8.1): an
// entry number's YYYYMM is its entry_date's month, and no journal is dated before the books start
// (1 Dec 2026, D-22). Upgrades a 0055 database holding valid journals (kept, still readable), and
// shows that a 0055 database holding a violating row refuses the migration (the deploy then aborts
// before any app container is touched; the runbook's pre-check query finds such rows first). Two
// disposable databases of their own, never `ammari` or `ammari_test`.

const VALID_DATABASE = "ammari_scratch_migration_0056";
const VIOLATING_DATABASE = "ammari_scratch_migration_0056_bad";

type Client = ReturnType<typeof postgres>;
let valid: Client;
let violating: Client;
let upTo0055: string;
let upTo0056: string;

async function staffId(client: Client): Promise<string> {
  const [role] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', ${`owner-${Math.random()}@example.test`}, ${role!.id}) returning id`;
  return staff!.id as string;
}

/** A balanced manual journal, committed. */
async function post(client: Client, staff: string, entryNo: string, entryDate: string): Promise<void> {
  await client.begin(async (tx) => {
    const [entry] = await tx`
      insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id)
      values (${entryNo}, ${entryDate}, 'manual', 'Uji 0056', ${staff}) returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_code, debit) values (${entry!.id}, 1, '1-1201', 10)`;
    await tx`insert into journal_lines (entry_id, line_no, account_code, credit) values (${entry!.id}, 2, '3-1001', 10)`;
  });
}

beforeAll(async () => {
  upTo0055 = migrationsUpTo(55);
  upTo0056 = migrationsUpTo(56);
  await recreateScratchDatabase(VALID_DATABASE);
  await recreateScratchDatabase(VIOLATING_DATABASE);
  valid = postgres(scratchUrl(VALID_DATABASE), { max: 2, onnotice: () => {} });
  violating = postgres(scratchUrl(VIOLATING_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(valid), { migrationsFolder: upTo0055 });
  await migrate(drizzle(violating), { migrationsFolder: upTo0055 });
}, 60_000);

afterAll(async () => {
  await valid?.end();
  await violating?.end();
  for (const dir of [upTo0055, upTo0056]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(VALID_DATABASE);
  await dropScratchDatabase(VIOLATING_DATABASE);
});

describe("upgrade from 0055", () => {
  test("valid journals (trial month and official books) upgrade unchanged", async () => {
    const staff = await staffId(valid);
    await post(valid, staff, "JU-202612-0001", "2026-12-01");
    await post(valid, staff, "JU-202701-0001", "2027-01-31");
    await migrate(drizzle(valid), { migrationsFolder: upTo0056 });
    const rows = await valid`select entry_no, entry_date::text as entry_date from journal_entries order by entry_no`;
    expect(rows.map((row) => [row.entry_no, row.entry_date])).toEqual([
      ["JU-202612-0001", "2026-12-01"],
      ["JU-202701-0001", "2027-01-31"],
    ]);
    // Re-running the migrator applies nothing.
    await migrate(drizzle(valid), { migrationsFolder: upTo0056 });
  });

  test("after 0056: a number whose month is not the entry's month is refused", async () => {
    const staff = await staffId(valid);
    await expect(post(valid, staff, "JU-202701-0002", "2027-02-01")).rejects.toThrow(/journal_entries_entry_no_month_check/);
    await expect(post(valid, staff, "JU-202612-0002", "2027-12-15")).rejects.toThrow(/journal_entries_entry_no_month_check/);
    await post(valid, staff, "JU-202712-0001", "2027-12-15");
  });

  test("after 0056: nothing is dated before the trial month", async () => {
    const staff = await staffId(valid);
    await expect(post(valid, staff, "JU-202611-0001", "2026-11-30")).rejects.toThrow(/journal_entries_entry_date_floor_check/);
  });

  test("a 0055 database holding a violating journal refuses the migration (nothing applied)", async () => {
    const staff = await staffId(violating);
    await post(violating, staff, "JU-202701-0001", "2026-12-15");
    await expect(migrate(drizzle(violating), { migrationsFolder: upTo0056 })).rejects.toThrow();
    const constraints = await violating`
      select conname from pg_constraint where conname in ('journal_entries_entry_no_month_check', 'journal_entries_entry_date_floor_check')`;
    expect(constraints).toHaveLength(0);
  });
});
