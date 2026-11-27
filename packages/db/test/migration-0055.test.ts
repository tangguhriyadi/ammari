import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FIXED_ASSET_ACCOUNT_MAPPINGS, FIXED_ASSET_GROUPS, INITIAL_CAPITALIZATION_THRESHOLD } from "../src/accounting/chart-of-accounts";
import { dropScratchDatabase, migrationsFolder, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0055 (Session 11, D-19): the fixed asset register and its settings. Upgrades a 0054
// database: the reference rows equal the constants, re-running the hand-authored inserts is a no-op,
// and the guards refuse what the register must never hold. Runs against a disposable database of its
// own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_migration_0055";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0054: string;
let upTo0055: string;
let staffId: string;

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  upTo0054 = migrationsUpTo(54);
  upTo0055 = migrationsUpTo(55);
  await migrate(drizzle(client), { migrationsFolder: upTo0054 });
  await migrate(drizzle(client), { migrationsFolder: upTo0055 });
  const [role] = await client`select id from roles where key = 'owner'`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Uji', 'uji-0055@example.com', ${role?.id as string}) returning id`;
  staffId = staff?.id as string;
});

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0054, upTo0055]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

const insertAsset = (overrides: Record<string, unknown> = {}) =>
  client`insert into fixed_assets ${client({
    name: "Mesin",
    group_code: "group_1",
    useful_life_months: 48,
    acquisition_date: "2027-01-20",
    cost: 2_000_000,
    asset_account_code: "1-2101",
    accumulated_account_code: "1-2191",
    funding_account_code: "1-1201",
    created_by_staff_user_id: staffId,
    updated_by_staff_user_id: staffId,
    ...overrides,
  })} returning id`;

describe("0055 reference data", () => {
  test("groups, threshold and the disposal mapping equal the constants", async () => {
    const groups = await client`select code, label, useful_life_months, sort_order from fixed_asset_groups order by sort_order`;
    expect(groups.map((row) => ({ code: row.code, label: row.label, usefulLifeMonths: row.useful_life_months, sortOrder: row.sort_order }))).toEqual(FIXED_ASSET_GROUPS);
    const [settings] = await client`select capitalization_threshold from fixed_asset_settings where id = 1`;
    expect(Number(settings?.capitalization_threshold)).toBe(INITIAL_CAPITALIZATION_THRESHOLD);
    const mappings = await client`select mapping_key, account_code from account_mappings where mapping_key like 'fixed_asset.%'`;
    expect(mappings.map((row) => ({ mappingKey: row.mapping_key, accountCode: row.account_code }))).toEqual(FIXED_ASSET_ACCOUNT_MAPPINGS);
  });

  test("re-running the hand-authored inserts changes nothing (and keeps an edit)", async () => {
    await client`update fixed_asset_groups set useful_life_months = 50 where code = 'group_1'`;
    const statement = readFileSync(path.join(migrationsFolder, "0055_accounting_fixed_assets.sql"), "utf8");
    const inserts = statement.split("--> statement-breakpoint").filter((part) => /^\s*(--[^\n]*\n\s*)*INSERT/m.test(part) && part.includes("INSERT INTO"));
    expect(inserts.length).toBe(3);
    for (const part of inserts) await client.unsafe(part);
    const [group] = await client`select useful_life_months from fixed_asset_groups where code = 'group_1'`;
    expect(group?.useful_life_months).toBe(50);
    expect((await client`select count(*)::int as n from fixed_asset_groups`)[0]?.n).toBe(2);
    await client`update fixed_asset_groups set useful_life_months = 48 where code = 'group_1'`;
  });
});

describe("0055 guards", () => {
  test("a valid asset inserts", async () => {
    await expect(insertAsset()).resolves.toHaveLength(1);
  });

  test("shape CHECKs refuse bad rows", async () => {
    await expect(insertAsset({ cost: 0 })).rejects.toThrow(/fixed_assets_cost_check/);
    await expect(insertAsset({ asset_account_code: "1-1504" })).rejects.toThrow(/fixed_assets_asset_account_check/);
    await expect(insertAsset({ accumulated_account_code: "1-2101" })).rejects.toThrow(/fixed_assets_accumulated_account_check/);
    await expect(insertAsset({ funding_account_code: "6-2101" })).rejects.toThrow(/fixed_assets_funding_account_check/);
    await expect(insertAsset({ disposed_on: "2027-01-01", disposal_proceeds: 0 })).rejects.toThrow(/fixed_assets_disposal_check/);
    await expect(insertAsset({ disposed_on: "2027-02-01", disposal_proceeds: 5, disposal_cash_account_code: null })).rejects.toThrow(/fixed_assets_disposal_check/);
    await expect(insertAsset({ voided_at: "2027-02-01T00:00:00Z" })).rejects.toThrow(/fixed_assets_void_check/);
    await expect(insertAsset({ disposed_on: "2027-02-01" })).rejects.toThrow(/fixed_assets_disposal_check/);
    await expect(insertAsset({ group_code: "group_9" })).rejects.toThrow(/foreign key/);
  });

  test("never deleted; a voided asset is final; a group's code is immutable", async () => {
    const [row] = await insertAsset();
    const id = row?.id as string;
    await expect(client`delete from fixed_assets where id = ${id}`).rejects.toThrow(/never deleted/);
    await client`update fixed_assets set voided_at = now(), void_reason = 'salah' where id = ${id}`;
    await expect(client`update fixed_assets set name = 'x' where id = ${id}`).rejects.toThrow(/voided asset is never changed/);
    await expect(client`update fixed_asset_groups set code = 'group_x' where code = 'group_2'`).rejects.toThrow(/immutable/);
    await expect(client`delete from fixed_asset_settings`).rejects.toThrow(/never deleted/);
    await expect(client`insert into fixed_asset_settings (id, capitalization_threshold) values (2, 1)`).rejects.toThrow(/singleton/);
  });
});
