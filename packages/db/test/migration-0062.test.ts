import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0062 (TikTok Shop T8, docs/plans/tiktok-shop-integration.md §3.6): the mapping key
// cash.tiktok_payout → 1-1201 Bank utama (Q17) and account_mappings_guard_target's two new key families.
// Upgrades a database at 0061 on its own scratch database; re-running the file is a no-op.

const SCRATCH_DATABASE = "ammari_scratch_migration_0062";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0061: string;
let upTo0062: string;

beforeAll(async () => {
  upTo0061 = migrationsUpTo(61);
  upTo0062 = migrationsUpTo(62);
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: upTo0061 });
  await migrate(drizzle(client), { migrationsFolder: upTo0062 });
}, 60_000);

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0061, upTo0062]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

/** The statement's refusal message, or null when it went through (each in its own transaction). */
async function refusal(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string | null> {
  try {
    await client.begin(async (tx) => {
      await run(tx);
      throw new Error("rollback");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message === "rollback" ? null : message;
  }
  return null;
}

describe("0062 TikTok accounting reference data", () => {
  test("cash.tiktok_payout points at 1-1201 Bank utama; no tiktok.adjustment.* row is shipped", async () => {
    expect(await client`select mapping_key, account_code from account_mappings where mapping_key = 'cash.tiktok_payout'`).toEqual([{ mapping_key: "cash.tiktok_payout", account_code: "1-1201" }]);
    expect(await client`select count(*)::int as n from account_mappings where mapping_key like 'tiktok.adjustment.%'`).toEqual([{ n: 0 }]);
  });

  test("re-running the migration's statements is a no-op and keeps an accountant's re-mapping", async () => {
    await client.begin(async (tx) => {
      await tx`insert into accounts (code, name, type, normal_balance, parent_code, cash_flow_group) values ('1-1202', 'Bank kedua', 'asset', 'debit', '1-1200', 'cash')`;
      await tx`update account_mappings set account_code = '1-1202' where mapping_key = 'cash.tiktok_payout'`;
      await tx.unsafe(`INSERT INTO "account_mappings" ("mapping_key", "account_code") SELECT 'cash.tiktok_payout', '1-1201' WHERE EXISTS (SELECT 1 FROM "accounts" WHERE "code" = '1-1201' AND "is_active" AND NOT "is_header") ON CONFLICT DO NOTHING`);
      expect(await tx`select account_code from account_mappings where mapping_key = 'cash.tiktok_payout'`).toEqual([{ account_code: "1-1202" }]);
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });

  test("cash.tiktok_payout only onto Kas & Bank", async () => {
    expect(await refusal((tx) => tx`update account_mappings set account_code = '6-1101' where mapping_key = 'cash.tiktok_payout'`)).toMatch(/cash or bank account/);
    expect(await refusal((tx) => tx`update account_mappings set account_code = '1-1101' where mapping_key = 'cash.tiktok_payout'`)).toBeNull();
  });

  test("tiktok.adjustment.*: an expense or income account yes; inventory and Saldo Penjual TikTok never", async () => {
    expect(await refusal((tx) => tx`insert into account_mappings (mapping_key, account_code) values ('tiktok.adjustment.ads_payment', '6-1101')`)).toBeNull();
    expect(await refusal((tx) => tx`insert into account_mappings (mapping_key, account_code) values ('tiktok.adjustment.platform_compensation', '7-1103')`)).toBeNull();
    expect(await refusal((tx) => tx`insert into account_mappings (mapping_key, account_code) values ('tiktok.adjustment.ads_payment', '1-1504')`)).toMatch(/inventory account/);
    expect(await refusal((tx) => tx`insert into account_mappings (mapping_key, account_code) values ('tiktok.adjustment.ads_payment', '1-1303')`)).toMatch(/seller balance/);
  });

  test("the families of 0051 are unchanged", async () => {
    expect(await refusal((tx) => tx`update account_mappings set account_code = '1-1501' where mapping_key = 'expense.category.ads_tiktok'`)).toMatch(/inventory account/);
    expect(await refusal((tx) => tx`update account_mappings set account_code = '6-1101' where mapping_key = 'cash.midtrans_payout'`)).toMatch(/cash or bank account/);
    expect(await refusal((tx) => tx`update account_mappings set account_code = '6-1101' where mapping_key = 'revenue.channel.tiktok'`)).toMatch(/revenue account/);
    expect(await refusal((tx) => tx`update account_mappings set account_code = '6-1101' where mapping_key = 'supplier_payable.kind.material'`)).toMatch(/liability account/);
  });
});
