import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0061 (TikTok Shop T7, docs/plans/tiktok-shop-integration.md §3.5): the finance tables and
// order_channel_fees.source. Upgrades a database at 0060 that already holds a Shopee-style fee row,
// checks that the row reads `actual` and that the previous release's insert (no source column) still
// works, and the constraints the finance code relies on. A disposable database of its own.

const SCRATCH_DATABASE = "ammari_scratch_migration_0061";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0060: string;
let upTo0061: string;
let orderId: string;
const SHA = "a".repeat(64);

/** The scratch database is dropped after the run, so rows stay (a refused statement inside one
 * transaction would abort the rest of it). Ids are unique per test. */
async function withScratch(run: (tx: Client) => Promise<void>): Promise<void> {
  await run(client);
}

async function snapshot(c: Client, kind: string, id: string): Promise<string> {
  const [row] = await c`insert into tiktok_finance_snapshots (kind, external_id, content_sha256, payload) values (${kind}, ${id}, ${SHA}, '{}'::jsonb) returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  upTo0060 = migrationsUpTo(60);
  upTo0061 = migrationsUpTo(61);
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: upTo0060 });
  const [order] = await client`
    insert into orders (order_no, channel_id, status, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount, channel_order_no)
    values ('ORD-0061', 'shopee', 'to_ship', '2026-11-28', 100000, 0, 0, 100000, 'SP-0061') returning id`;
  orderId = order!.id as string;
  await client`insert into order_channel_fees (order_id, component, amount) values (${orderId}, 'admin_fee', 5000)`;
  await migrate(drizzle(client), { migrationsFolder: upTo0061 });
}, 60_000);

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0060, upTo0061]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("0061 order_channel_fees.source", () => {
  test("an existing row reads actual; the previous release's insert and upsert (no source) still work", async () => {
    expect(await client`select component, amount::int as amount, source from order_channel_fees where order_id = ${orderId}`).toEqual([{ component: "admin_fee", amount: 5000, source: "actual" }]);
    await client`
      insert into order_channel_fees (order_id, component, amount) values (${orderId}, 'admin_fee', 6000), (${orderId}, 'service_fee', 1000)
      on conflict (order_id, component) do update set amount = excluded.amount, updated_at = now()`;
    expect(await client`select component, amount::int as amount, source from order_channel_fees where order_id = ${orderId} order by component`).toEqual([
      { component: "admin_fee", amount: 6000, source: "actual" },
      { component: "service_fee", amount: 1000, source: "actual" },
    ]);
  });

  test("only estimate or actual", async () => {
    await withScratch(async (tx) => {
      await tx`insert into order_channel_fees (order_id, component, amount, source) values (${orderId}, 'other', 1, 'estimate')`;
      await expect(tx`insert into order_channel_fees (order_id, component, amount, source) values (${orderId}, 'affiliate_commission', 1, 'guess')`).rejects.toThrow(/order_channel_fees_source_check/);
    });
  });
});

describe("0061 finance constraints", () => {
  test("snapshots: one row per content version", async () => {
    await withScratch(async (tx) => {
      await snapshot(tx, "statement", "s-1");
      await expect(snapshot(tx, "statement", "s-1")).rejects.toThrow(/tiktok_finance_snapshots_version_key/);
      await expect(tx`insert into tiktok_finance_snapshots (kind, external_id, content_sha256, payload) values ('order', 'x', ${SHA}, '{}')`).rejects.toThrow(/kind_check/);
    });
  });

  test("a statement stores money only in IDR with a settlement, or is held", async () => {
    await withScratch(async (tx) => {
      const snap = await snapshot(tx, "statement", "s-2");
      const base = { statement_time: new Date().toISOString(), latest_snapshot_id: snap, fetched_at: new Date().toISOString() };
      await expect(tx`insert into tiktok_statements ${tx({ ...base, statement_id: "s-usd", currency: "USD", settlement_amount: 1 })}`).rejects.toThrow(/tiktok_statements_currency_check/);
      await expect(tx`insert into tiktok_statements ${tx({ ...base, statement_id: "s-null", currency: "IDR" })}`).rejects.toThrow(/tiktok_statements_currency_check/);
      await tx`insert into tiktok_statements ${tx({ ...base, statement_id: "s-held", currency: "USD", held_reason: "currency" })}`;
      await tx`insert into tiktok_statements ${tx({ ...base, statement_id: "s-ok", currency: "IDR", settlement_amount: 205000 })}`;
      const txBase = { statement_id: "s-ok", type: "ORDER", content_sha256: SHA, latest_snapshot_id: snap, fetched_at: new Date().toISOString(), settlement_amount: 1 };
      await expect(tx`insert into tiktok_statement_transactions ${tx({ ...txBase, transaction_id: "t-1", kind: "adjustment", fees_state: "pending", tiktok_order_id: "o" })}`).rejects.toThrow(/fees_kind_check/);
      await expect(tx`insert into tiktok_statement_transactions ${tx({ ...txBase, transaction_id: "t-2", kind: "order", fees_state: "held", tiktok_order_id: "o" })}`).rejects.toThrow(/fees_held_check/);
      await expect(tx`insert into tiktok_statement_transactions ${tx({ ...txBase, transaction_id: "t-3", kind: "order", settlement_amount: null })}`).rejects.toThrow(/money_check/);
      await tx`insert into tiktok_statement_transactions ${tx({ ...txBase, transaction_id: "t-4", kind: "order", fees_state: "pending", tiktok_order_id: "o" })}`;
      await expect(tx`insert into tiktok_statement_transactions ${tx({ ...txBase, transaction_id: "t-5", statement_id: "nope", kind: "order" })}`).rejects.toThrow(/foreign key/);
    });
  });

  test("fee lines: one per source × transaction × SKU × group × type; estimate and actual sit side by side", async () => {
    await withScratch(async (tx) => {
      const line = { tiktok_order_id: "o", transaction_id: "t", fee_group: "fee", fee_type: "platform_commission_amount", amount: -100, fetched_at: new Date().toISOString() };
      await tx`insert into tiktok_order_fee_lines ${tx({ ...line, source: "estimate" })}`;
      await tx`insert into tiktok_order_fee_lines ${tx({ ...line, source: "actual" })}`;
      await expect(tx`insert into tiktok_order_fee_lines ${tx({ ...line, source: "actual" })}`).rejects.toThrow(/grain_key/);
      await expect(tx`insert into tiktok_order_fee_lines ${tx({ ...line, source: "actual", fee_group: "revenue" })}`).rejects.toThrow(/group_check/);
    });
  });

  test("order fee state: a held state always names its reason", async () => {
    await withScratch(async (tx) => {
      await expect(tx`insert into tiktok_order_fees (tiktok_order_id, state) values ('o-1', 'held')`).rejects.toThrow(/held_pair_check/);
      await expect(tx`insert into tiktok_order_fees (tiktok_order_id, state, held_reason) values ('o-2', 'applied', 'fee_negative')`).rejects.toThrow(/held_pair_check/);
      await tx`insert into tiktok_order_fees (tiktok_order_id, state, held_reason, unmapped_types) values ('o-3', 'held', 'fee_type_unmapped', ${["fee.new_fee_amount"]})`;
    });
  });

  test("payouts: IDR amount or held; only four digits of the bank account", async () => {
    await withScratch(async (tx) => {
      const snap = await snapshot(tx, "payment", "p");
      const base = { content_sha256: SHA, latest_snapshot_id: snap, fetched_at: new Date().toISOString() };
      await expect(tx`insert into tiktok_payouts ${tx({ ...base, payment_id: "p-1", amount: 1, currency: "IDR", bank_account_last4: "123456" })}`).rejects.toThrow(/last4_check/);
      await expect(tx`insert into tiktok_payouts ${tx({ ...base, payment_id: "p-2", currency: "IDR" })}`).rejects.toThrow(/money_check/);
      await tx`insert into tiktok_payouts ${tx({ ...base, payment_id: "p-3", amount: 205000, currency: "IDR", bank_account_last4: "3456" })}`;
    });
  });
});
