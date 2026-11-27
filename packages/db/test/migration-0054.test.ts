import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CASH_FLOW_GROUP_BEFORE_0054, CHART_OF_ACCOUNTS } from "../src/accounting/chart-of-accounts";
import { dropScratchDatabase, migrationsFolder, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0054 (Akuntansi, owner + accountant 27 Nov 2026): Piutang Midtrans and the marketplace
// balances are receivables, not cash. Upgrades a 0053 database in which the accountant has already
// re-grouped one of the four rows herself: that edit is kept, the other three move from `cash` to the
// group the constants now hold, nothing else changes, and re-running the statement is a no-op. Runs
// against a disposable database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_migration_0054";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0053: string;
let upTo0054: string;
let before: Map<string, string>;

const groups = async () => new Map((await client`select code, cash_flow_group from accounts`).map((row) => [row.code as string, row.cash_flow_group as string]));

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  upTo0053 = migrationsUpTo(53);
  upTo0054 = migrationsUpTo(54);
  await migrate(drizzle(client), { migrationsFolder: upTo0053 });
  // The accountant's own edit before 0054 ships: she already put Saldo Penjual TikTok elsewhere.
  await client`update accounts set cash_flow_group = 'investing' where code = '1-1303'`;
  before = await groups();
  await migrate(drizzle(client), { migrationsFolder: upTo0054 });
});

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0053, upTo0054]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("upgrade from 0053", () => {
  test("rows still at the seeded `cash` become receivables (operating), as the constants say", async () => {
    const after = await groups();
    for (const code of ["1-1301", "1-1302", "1-1305"]) {
      expect(before.get(code)).toBe(CASH_FLOW_GROUP_BEFORE_0054[code]);
      expect(after.get(code)).toBe("operating");
      expect(after.get(code)).toBe(CHART_OF_ACCOUNTS.find((account) => account.code === code)?.cashFlowGroup);
    }
  });

  test("an accountant's own edit is never overwritten; every other row is unchanged", async () => {
    const after = await groups();
    expect(after.get("1-1303")).toBe("investing");
    for (const [code, group] of before) if (!["1-1301", "1-1302", "1-1305"].includes(code)) expect(after.get(code), code).toBe(group);
  });

  test("cash is Kas tunai and Bank only", async () => {
    const cash = await client`select code from accounts where cash_flow_group = 'cash' order by code`;
    expect(cash.map((row) => row.code)).toEqual(["1-1101", "1-1201"]);
    expect(CHART_OF_ACCOUNTS.filter((account) => account.cashFlowGroup === "cash").map((account) => account.code)).toEqual(["1-1101", "1-1201"]);
  });

  test("re-running the statement changes nothing", async () => {
    const statement = readFileSync(path.join(migrationsFolder, "0054_accounting_receivables_not_cash.sql"), "utf8");
    const snapshot = await groups();
    await client.unsafe(statement);
    expect(await groups()).toEqual(snapshot);
  });
});
