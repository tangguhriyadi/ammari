import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0053 (Akuntansi Session 6, D-3: order_manual_payments). Upgrades a 0052 database that
// already holds manual orders, then proves the migration is expand-only: existing orders keep no
// payment row (they become "Isi cara bayar" work and an S6 posting issue, never a default), and the
// previous release's write path (an order insert without any payment row) still works, so a
// rollback to it is safe. The trigger's per-rule behaviour is covered against ammari_test in
// apps/admin/src/lib/orders/manual-payment.test.ts.

const SCRATCH_DATABASE = "ammari_scratch_migration_0053";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0052: string;
let upTo0053: string;
let staffId: string;

async function insertManualOrder(orderNo: string, status: string): Promise<string> {
  const [order] = await client`
    insert into orders (channel_id, order_no, status, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
    values ('whatsapp', ${orderNo}, ${status}, now(), 259000, 0, 0, 259000) returning id`;
  return order!.id as string;
}

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  upTo0052 = migrationsUpTo(52);
  upTo0053 = migrationsUpTo(53);
  await migrate(drizzle(client), { migrationsFolder: upTo0052 });

  const [role] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
  staffId = staff!.id as string;
  await insertManualOrder("ORD-OLD-0001", "to_ship");
  await insertManualOrder("ORD-OLD-0002", "awaiting_payment");

  await migrate(drizzle(client), { migrationsFolder: upTo0053 });
});

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0052, upTo0053]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("upgrade from 0052", () => {
  test("adds an empty table with validated constraints and its triggers; existing orders are untouched", async () => {
    const [{ invalid }] = (await client`select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
    expect(invalid).toBe(0);
    const [{ rows }] = (await client`select count(*)::int as rows from order_manual_payments`) as unknown as [{ rows: number }];
    expect(rows).toBe(0);
    const triggers = await client`select tgname from pg_trigger where tgrelid = 'order_manual_payments'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((row) => row.tgname)).toEqual(["order_manual_payments_guard", "order_manual_payments_guard_delete", "set_updated_at"]);
    const [{ orders }] = (await client`select count(*)::int as orders from orders where order_no like 'ORD-OLD-%'`) as unknown as [{ orders: number }];
    expect(orders).toBe(2);
  });

  test("the previous release's order insert (no payment row) still works: rollback stays safe", async () => {
    await expect(insertManualOrder("ORD-OLD-0003", "to_ship")).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  test("accounts_guard_update keeps 0051's refusals (a mapped account is not deactivated)", async () => {
    await expect(client`update accounts set is_active = false where code = '1-1201'`).rejects.toThrow(/system|mapping points at/);
    await expect(client`update accounts set type = 'liability' where code = '1-1409'`).rejects.toThrow(/immutable/);
  });

  test("an order whose stock never left gets no payment row (never paid, D-3)", async () => {
    const [order] = await client`select id from orders where order_no = 'ORD-OLD-0002'`;
    await expect(
      client`insert into order_manual_payments (order_id, method, cash_account_code, paid_on, recorded_by_staff_user_id)
        values (${order!.id}, 'cash', '1-1101', '2026-12-10', ${staffId})`,
    ).rejects.toThrow(/has not reached to_ship/);
  });
});
