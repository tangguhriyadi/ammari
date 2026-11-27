import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { appConnectionProblems, appRoleProblems, PROTECTED_TABLES, scramSha256Verifier, setupAppRole } from "../src/ops/app-role";
import { dropScratchDatabase, migrationsFolder, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// The apps' own database role (docs/plans/accounting.md §8.1 Session 12, runbook R1): after
// setupAppRole the role reads and writes every table but cannot TRUNCATE (which would bypass every
// append-only trigger), cannot disable triggers or create objects, and a table a later migration
// creates gets the same grants; appRoleProblems flags every way it could go wrong. A scratch
// database of its own and a throwaway role (cluster-wide, so its name is random and it is dropped
// afterwards), never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_app_role";
const APP_ROLE = `ammari_scratch_app_${randomBytes(4).toString("hex")}`;
const PASSWORD = randomBytes(24).toString("hex");

let owner: postgres.Sql;
let app: postgres.Sql | undefined;

function appUrl(password = PASSWORD): string {
  const url = new URL(scratchUrl(SCRATCH_DATABASE));
  url.username = APP_ROLE;
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  owner = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(owner), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await dropScratchDatabase(SCRATCH_DATABASE);
  // The role outlives the database; its grants in the scratch database went with it.
  const admin = postgres(scratchUrl(SCRATCH_DATABASE).replace(/\/ammari_scratch_app_role/, "/postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop role if exists "${APP_ROLE}"`);
  } finally {
    await admin.end();
  }
});

describe("setupAppRole + appRoleProblems", () => {
  test("a missing role is a problem; creating one without a password is refused", async () => {
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([`role ${APP_ROLE} does not exist`]);
    await expect(setupAppRole(owner, APP_ROLE, null)).rejects.toThrow(/APP_DB_PASSWORD/);
    await expect(setupAppRole(owner, APP_ROLE, "short")).rejects.toThrow(/32-128 letters and digits/);
    await expect(setupAppRole(owner, "Bad-Name", PASSWORD)).rejects.toThrow(/APP_DB_ROLE/);
  });

  test("the password reaches the server only as a SCRAM-SHA-256 verifier", () => {
    const salt = Buffer.alloc(16, 1);
    const verifier = scramSha256Verifier(PASSWORD, salt);
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(verifier).not.toContain(PASSWORD);
    expect(scramSha256Verifier(PASSWORD, salt)).toBe(verifier);
    expect(scramSha256Verifier(PASSWORD)).not.toBe(verifier);
  });

  test("after setup the check passes, and re-running it is a no-op", async () => {
    await setupAppRole(owner, APP_ROLE, PASSWORD);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([]);
    await setupAppRole(owner, APP_ROLE, null);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([]);
    // Stored as the verifier we computed; the login below (with the plaintext) proves it matches.
    const [stored] = await owner`select rolpassword from pg_authid where rolname = ${APP_ROLE}`;
    expect(String(stored!.rolpassword)).toMatch(/^SCRAM-SHA-256\$4096:/);
    app = postgres(appUrl(), { max: 1, onnotice: () => {} });
  });

  test("the apps' own URLs: the app role's passes; the owner's, or a wrong password, fails", async () => {
    expect(await appConnectionProblems(appUrl(), APP_ROLE, "admin.env DATABASE_URL")).toEqual([]);
    expect(await appConnectionProblems(scratchUrl(SCRATCH_DATABASE), APP_ROLE, "web.env DATABASE_URL")).toEqual([
      `web.env DATABASE_URL does not log in as ${APP_ROLE} (the app still connects as another role)`,
    ]);
    const wrong = await appConnectionProblems(appUrl("0".repeat(40)), APP_ROLE, "admin.env DATABASE_URL");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatch(/^admin\.env DATABASE_URL cannot log in as /);
    expect(wrong[0]).not.toContain(PASSWORD);
  });

  test("the app role reads and writes, but cannot TRUNCATE any protected table, disable a trigger or create a table", async () => {
    const [{ count }] = (await app!`select count(*)::int as count from accounts`) as unknown as [{ count: number }];
    expect(count).toBeGreaterThan(0);
    await app!`insert into posting_runs (trigger) values ('cron')`;
    await app!`update posting_runs set status = 'succeeded', finished_at = now() where status = 'running'`;
    for (const table of PROTECTED_TABLES) {
      await expect(app!.unsafe(`truncate table "${table}"`), table).rejects.toThrow(/permission denied/);
    }
    await expect(app!`truncate journal_entries cascade`).rejects.toThrow(/permission denied/);
    await expect(app!.unsafe(`alter table journal_lines disable trigger all`)).rejects.toThrow(/must be owner/);
    await expect(app!.unsafe(`create table app_owned (id int)`)).rejects.toThrow(/permission denied/);
    // The append-only triggers still guard row deletes.
    await owner.begin(async (tx) => {
      const [role] = await tx`select id from roles where key = 'owner'`;
      const [staff] = await tx`insert into staff_users (name, email, role_id) values ('Owner', 'owner-app-role@example.test', ${role!.id}) returning id`;
      const [entry] = await tx`
        insert into journal_entries (entry_no, entry_date, kind, description, posted_by_staff_user_id)
        values ('JU-202701-0001', '2027-01-10', 'manual', 'Uji peran aplikasi', ${staff!.id}) returning id`;
      await tx`insert into journal_lines (entry_id, line_no, account_code, debit) values (${entry!.id}, 1, '1-1201', 10)`;
      await tx`insert into journal_lines (entry_id, line_no, account_code, credit) values (${entry!.id}, 2, '3-1001', 10)`;
    });
    await expect(app!`delete from journal_lines`).rejects.toThrow(/append-only/);
  });

  test("a table a later migration creates (as the owner) gets the same grants", async () => {
    await owner.unsafe(`create table later_table (id int primary key)`);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([]);
    await app!`insert into later_table (id) values (1)`;
    await expect(app!`truncate later_table`).rejects.toThrow(/permission denied/);
    await owner.unsafe(`drop table later_table`);
  });

  test("the check fails loudly on TRUNCATE, missing DML, owner membership, superuser-like rights and the owner itself", async () => {
    await owner.unsafe(`grant truncate on journal_lines to "${APP_ROLE}"`);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([`${APP_ROLE} has TRUNCATE on journal_lines`]);
    await owner.unsafe(`revoke truncate on journal_lines from "${APP_ROLE}"`);

    await owner.unsafe(`revoke delete on carts from "${APP_ROLE}"`);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([`${APP_ROLE} lacks DELETE on carts (the app would fail on it)`]);

    const [{ name: ownerName }] = (await owner`select current_user as name`) as unknown as [{ name: string }];
    await owner.unsafe(`grant "${ownerName}" to "${APP_ROLE}"`);
    await owner.unsafe(`grant pg_write_all_data to "${APP_ROLE}"`);
    await owner.unsafe(`alter role "${APP_ROLE}" createdb`);
    await owner.unsafe(`create view app_view as select 1 as one`);
    await owner.unsafe(`grant trigger on app_view to "${APP_ROLE}"`);
    const problems = await appRoleProblems(owner, APP_ROLE);
    expect(problems).toContain(`${APP_ROLE} is a member of ${ownerName} (SET ROLE would reach its rights)`);
    expect(problems).toContain(`${APP_ROLE} is a member of pg_write_all_data (SET ROLE would reach its rights)`);
    expect(problems).toContain(`${APP_ROLE} has CREATEDB`);
    expect(problems).toContain(`${APP_ROLE} has TRIGGER on app_view`);
    expect(problems.some((problem) => problem.includes("lacks") && problem.includes("app_view"))).toBe(false);

    // Setup repairs all of it.
    await setupAppRole(owner, APP_ROLE, null);
    expect(await appRoleProblems(owner, APP_ROLE)).toEqual([]);
    await owner.unsafe(`drop view app_view`);

    const asOwner = await appRoleProblems(owner, ownerName);
    expect(asOwner.some((problem) => problem.includes("runs as") || problem.includes("owns objects"))).toBe(true);
  });
});
