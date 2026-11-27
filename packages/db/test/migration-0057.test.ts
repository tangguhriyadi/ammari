import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ownerDefaultPermissionKeys, PERMISSIONS, superAdminDefaultPermissionKeys } from "../src/rbac/permissions";
import { dropScratchDatabase, migrationsFolder, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0057 (TikTok Shop T2, docs/plans/tiktok-shop-integration.md §3.1, §3.2): four new tables
// and the integrations.manage permission. Upgrades a database at 0056, checks the permission row and
// its grants (super_admin and owner only), that re-running the migrator and the migration's own
// INSERTs is a no-op, and the constraints the connection code relies on. Runs against a disposable
// database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_migration_0057";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0056: string;
let upTo0057: string;

const grantsSql = (c: Client) => c`
  select r.key as role from role_permissions rp
  join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
  where p.key = 'integrations.manage' order by r.key`;

function referenceInsertStatements(): string[] {
  const sql = readFileSync(path.join(migrationsFolder, "0057_tiktok_connection.sql"), "utf8");
  const statements = sql.split("--> statement-breakpoint").filter((part) => /INSERT INTO "(permissions|role_permissions)"/.test(part));
  expect(statements).toHaveLength(2);
  return statements;
}

const TOKEN = Buffer.from([1, ...new Array(40).fill(7)]);

async function connection(c: Client, fields: Record<string, unknown>) {
  const row = {
    shop_id: `shop-${Math.random()}`,
    shop_cipher: "cipher",
    status: "active",
    access_token_ct: TOKEN,
    refresh_token_ct: TOKEN,
    token_key_version: 1,
    connected_at: new Date().toISOString(),
    ...fields,
  };
  return c`insert into tiktok_shop_connections ${c(row)} returning id`;
}

beforeAll(async () => {
  upTo0056 = migrationsUpTo(56);
  upTo0057 = migrationsUpTo(57);
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: upTo0056 });
  // Roles exist on a real database before 0057 (0012/0041 and the owner's bootstrap).
  await client`insert into roles (key, name, is_system) values ('super_admin', 'Super Admin', true), ('owner', 'Owner', true) on conflict (key) do nothing`;
  await client`insert into roles (key, name) values ('packing_warehouse_test', 'Packing') on conflict (key) do nothing`;
  await migrate(drizzle(client), { migrationsFolder: upTo0057 });
}, 60_000);

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0056, upTo0057]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

describe("0057 reference rows", () => {
  test("integrations.manage exists, equal to the TS catalog, granted to super_admin and owner only", async () => {
    const definition = PERMISSIONS.find((permission) => permission.key === "integrations.manage");
    expect(definition).toBeDefined();
    const rows = await client`select key, description, "group" from permissions where key = 'integrations.manage'`;
    expect(rows.map((row) => ({ key: row.key, description: row.description, group: row.group }))).toEqual([definition]);
    expect((await grantsSql(client)).map((row) => row.role)).toEqual(["owner", "super_admin"]);
    expect(superAdminDefaultPermissionKeys()).toContain("integrations.manage");
    expect(ownerDefaultPermissionKeys()).toContain("integrations.manage");
  });

  test("re-running the migrator and the migration's own INSERTs changes nothing", async () => {
    const before = await grantsSql(client);
    await migrate(drizzle(client), { migrationsFolder: upTo0057 });
    for (const statement of referenceInsertStatements()) await client.unsafe(statement);
    expect(await grantsSql(client)).toEqual(before);
    expect(await client`select count(*)::int as n from permissions where key = 'integrations.manage'`).toEqual([{ n: 1 }]);
  });
});

describe("0057 constraints", () => {
  test("at most one active connection", async () => {
    await client.begin(async (tx) => {
      await connection(tx as unknown as Client, {});
      await expect(connection(tx as unknown as Client, {})).rejects.toThrow(/tiktok_shop_connections_one_active/);
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
  });

  test("tokens: active needs them, deauthorized/disconnected must not have them, the two columns go together", async () => {
    await expect(connection(client, { access_token_ct: null, refresh_token_ct: null })).rejects.toThrow(/tokens_status_check/);
    await expect(connection(client, { status: "deauthorized" })).rejects.toThrow(/tokens_status_check/);
    await expect(connection(client, { status: "disconnected" })).rejects.toThrow(/tokens_status_check/);
    await expect(connection(client, { status: "reauth_required", refresh_token_ct: null })).rejects.toThrow(/tokens_paired_check/);
    await expect(connection(client, { status: "bogus" })).rejects.toThrow(/status_check/);
    const [wiped] = await connection(client, { status: "deauthorized", access_token_ct: null, refresh_token_ct: null });
    expect(wiped!.id).toBeTruthy();
    await client`delete from tiktok_shop_connections`;
  });

  test("OAuth state: only a SHA-256 hex hash, expiring after creation", async () => {
    const [role] = await client`select id from roles where key = 'owner'`;
    const [staff] = await client`insert into staff_users (name, email, role_id) values ('O', 'o-0057@example.test', ${role!.id}) returning id`;
    await expect(client`insert into tiktok_oauth_states (state_hash, staff_user_id, expires_at) values ('raw-state', ${staff!.id}, now() + interval '10 minutes')`).rejects.toThrow(
      /tiktok_oauth_states_hash_check/,
    );
    await expect(client`insert into tiktok_oauth_states (state_hash, staff_user_id, expires_at) values (${"a".repeat(64)}, ${staff!.id}, now() - interval '1 minute')`).rejects.toThrow(
      /tiktok_oauth_states_expiry_check/,
    );
  });

  test("inbox: deduped on tts_notification_id, status and payload size checked", async () => {
    await client`insert into tiktok_webhook_events (tts_notification_id, type) values ('n-1', 1)`;
    await expect(client`insert into tiktok_webhook_events (tts_notification_id, type) values ('n-1', 1)`).rejects.toThrow(/tts_notification_id_unique/);
    await expect(client`insert into tiktok_webhook_events (tts_notification_id, type, status) values ('n-2', 1, 'done')`).rejects.toThrow(/status_check/);
    await expect(client`insert into tiktok_webhook_events (tts_notification_id, type, payload) values ('n-3', 1, ${JSON.stringify({ x: "y".repeat(17_000) })}::jsonb)`).rejects.toThrow(
      /payload_size_check/,
    );
    await expect(client`insert into tiktok_sync_cursors (resource) values ('products')`).rejects.toThrow(/resource_check/);
  });
});
