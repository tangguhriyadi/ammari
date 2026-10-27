import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { PREDEFINED_ROLES, STAFF_ACCESS_LOCK_KEY } from "../src/rbac/permissions";

// Migration 0041 (staff invites, docs/plans/roles-staff.md §3): nullable invite/deactivation
// columns on staff_users, staff.manage for owner, the four predefined roles, and the deferred
// last-super_admin trigger. Upgrades a database sitting at 0040 that already has staff and one
// role an admin created by hand under a predefined key, then checks the backfill, the previous
// release's writes, the trigger (including two concurrent demotions), and that re-running is a
// no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0041_upgrade";

function urlFor(database: string): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to run migration tests against non-local host "${url.hostname}".`);
  }
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreateDatabase(): Promise<void> {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
}

function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ammari-migrations-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

type Sql = ReturnType<typeof postgres>;

async function grantsOf(client: Sql, roleKey: string): Promise<string[]> {
  const rows = await client<{ key: string }[]>`
    select p.key from role_permissions rp
    join roles r on r.id = rp.role_id
    join permissions p on p.id = rp.permission_id
    where r.key = ${roleKey}
    order by p.key`;
  return rows.map((row) => row.key);
}

describe("migration 0041 (staff invites, predefined roles, last super_admin trigger)", () => {
  test("upgrades a 0040 database without touching existing rows, and the trigger holds", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const second = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0040 = migrationsUpTo(40);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0040 });

      // State at 0040: migrations 0014+ already shipped both system roles and the catalog. One
      // super_admin, one owner, and an admin-made "finance" role holding a single permission.
      const [superRole] = await client`select id from roles where key = 'super_admin'`;
      const [ownerRole] = await client`select id from roles where key = 'owner'`;
      const [superA] = await client`
        insert into staff_users (name, email, role_id, last_login_at)
        values ('Suami', 'suami@example.test', ${superRole!.id}, now()) returning id`;
      await client`insert into staff_users (name, email, role_id) values ('Istri', 'istri@example.test', ${ownerRole!.id})`;
      const [customFinance] = await client`
        insert into roles (key, name, is_system) values ('finance', 'Keuangan Lama', false) returning id`;
      await client`
        insert into role_permissions (role_id, permission_id)
        select ${customFinance!.id}, id from permissions where key = 'orders.view'`;
      expect(await grantsOf(client, "owner")).not.toContain("staff.manage");

      await migrate(drizzle(client), { migrationsFolder });

      // Existing rows: every new column NULL (no invite expiry, never deactivated).
      const existing = await client`
        select invited_at, invite_expires_at, invited_by_staff_user_id, deactivated_at from staff_users`;
      expect(existing).toHaveLength(2);
      for (const row of existing) {
        expect(row).toEqual({ invited_at: null, invite_expires_at: null, invited_by_staff_user_id: null, deactivated_at: null });
      }

      // Owner answer 2: owner now holds staff.manage, still not roles.manage/audit_log.view.
      const ownerGrants = await grantsOf(client, "owner");
      expect(ownerGrants).toContain("staff.manage");
      expect(ownerGrants).not.toContain("roles.manage");
      expect(ownerGrants).not.toContain("audit_log.view");
      const [ownerDescription] = await client`select description from roles where key = 'owner'`;
      expect(ownerDescription!.description).toMatch(/staff\.manage/);

      // Predefined roles match PREDEFINED_ROLES exactly, except the one that already existed,
      // which is left exactly as the admin made it.
      for (const role of PREDEFINED_ROLES) {
        const [row] = await client`select name, description, is_system from roles where key = ${role.key}`;
        if (role.key === "finance") {
          expect(row!.name).toBe("Keuangan Lama");
          expect(await grantsOf(client, role.key)).toEqual(["orders.view"]);
          continue;
        }
        expect(row).toEqual({ name: role.name, description: role.description, is_system: false });
        expect(await grantsOf(client, role.key)).toEqual([...role.permissionKeys].sort());
      }
      // Every PREDEFINED_ROLES key the migration grants exists in the catalog (a typo would grant
      // nothing silently).
      const catalog = new Set((await client<{ key: string }[]>`select key from permissions`).map((row) => row.key));
      for (const role of PREDEFINED_ROLES) for (const key of role.permissionKeys) expect(catalog.has(key)).toBe(true);

      // The previous release's writes: a seed-style insert naming none of the new columns, and
      // the login stamp on the last super_admin (not a trigger column).
      await client`insert into staff_users (name, email, role_id) values ('Lama', 'lama@example.test', ${ownerRole!.id})`;
      await client`update staff_users set last_login_at = now() where id = ${superA!.id}`;

      // The CHECK: an expiry needs an invited_at.
      await expect(
        client`insert into staff_users (name, email, role_id, invite_expires_at) values ('X', 'x@example.test', ${ownerRole!.id}, now())`,
      ).rejects.toThrow(/staff_users_invite_expiry_check/);

      // The trigger: the only active super_admin can't be deactivated or moved to another role.
      await expect(client`update staff_users set is_active = false where id = ${superA!.id}`).rejects.toThrow(/last active super_admin/);
      await expect(client`update staff_users set role_id = ${ownerRole!.id} where id = ${superA!.id}`).rejects.toThrow(/last active super_admin/);
      // Deferred: demoting one and promoting another in the same transaction is fine.
      const [superB] = await client`
        insert into staff_users (name, email, role_id) values ('Cadangan', 'cadangan@example.test', ${superRole!.id}) returning id`;
      await client.begin(async (tx) => {
        await tx`update staff_users set role_id = ${ownerRole!.id} where id = ${superB!.id}`;
        await tx`update staff_users set role_id = ${superRole!.id} where id = ${superB!.id}`;
      });

      // Two super_admins, two concurrent transactions, each deactivating a different one: the
      // second to commit must fail (no write skew), leaving exactly one active super_admin.
      // A barrier, not a sleep: neither transaction commits until both have done their UPDATE,
      // so both commits really do overlap and the lock (not timing) is what decides.
      let arrived = 0;
      let release!: () => void;
      const bothUpdated = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrive = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothUpdated;
      };
      const results = await Promise.allSettled([
        client.begin(async (tx) => {
          await tx`update staff_users set is_active = false where id = ${superA!.id}`;
          await arrive();
        }),
        second.begin(async (tx) => {
          await tx`update staff_users set is_active = false where id = ${superB!.id}`;
          await arrive();
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/last active super_admin/);
      const [active] = await client`
        select count(*)::int as count from staff_users where is_active and role_id = ${superRole!.id}`;
      expect(active).toEqual({ count: 1 });

      // The survivor is now the only super_admin who can log in. A pending super_admin
      // invitation doesn't count (the person may never accept), and DELETE is guarded too.
      const [survivor] = await client`select id from staff_users where is_active and role_id = ${superRole!.id}`;
      await client`
        insert into staff_users (name, email, role_id, invited_at, invite_expires_at)
        values ('Undangan', 'undangan@example.test', ${superRole!.id}, now(), now() + interval '7 days')`;
      await expect(client`update staff_users set is_active = false where id = ${survivor!.id}`).rejects.toThrow(/last active super_admin/);
      await expect(client`delete from staff_users where id = ${survivor!.id}`).rejects.toThrow(/last active super_admin/);
      // Under REPEATABLE READ even a removal that would leave another super_admin is refused.
      await expect(
        client.begin("isolation level repeatable read", async (tx) => {
          await tx`update staff_users set is_active = false where email = 'undangan@example.test'`;
          await tx`update staff_users set last_login_at = now() where email = 'undangan@example.test'`;
          await tx`update staff_users set is_active = true where email = 'undangan@example.test'`;
          await tx`update staff_users set role_id = ${ownerRole!.id} where id = ${survivor!.id}`;
        }),
      ).rejects.toThrow(/READ COMMITTED/);
      // Deleting or demoting the pending invitation itself is fine.
      await client`delete from staff_users where email = 'undangan@example.test'`;

      // The trigger's lock key is the app's STAFF_ACCESS_LOCK_KEY.
      const [definition] = await client`select pg_get_functiondef('prevent_last_super_admin_loss'::regproc) as body`;
      expect(definition!.body).toContain(`hashtext('${STAFF_ACCESS_LOCK_KEY}')`);

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
      expect(await grantsOf(client, "finance")).toEqual(["orders.view"]);
    } finally {
      await client.end();
      await second.end();
      rmSync(upTo0040, { recursive: true, force: true });
    }
  });

  test("on a database with no super_admin, deactivating anyone is unaffected", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(client), { migrationsFolder });
      const [ownerRole] = await client`select id from roles where key = 'owner'`;
      const [owner] = await client`
        insert into staff_users (name, email, role_id) values ('Istri', 'istri@example.test', ${ownerRole!.id}) returning id`;
      await client`update staff_users set is_active = false where id = ${owner!.id}`;
      const [row] = await client`select is_active from staff_users where id = ${owner!.id}`;
      expect(row).toEqual({ is_active: false });
    } finally {
      await client.end();
    }
  });
});
