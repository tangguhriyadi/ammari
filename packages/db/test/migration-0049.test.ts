import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { CHART_OF_ACCOUNTS, DEFAULT_ACCOUNT_MAPPINGS, INITIAL_TAX_SETTING, systemAccountCode } from "../src/accounting/chart-of-accounts";
import { CHANNEL_IDS, DEFAULT_EXPENSE_CATEGORIES } from "../src/schema/constants";
import { ownerDefaultPermissionKeys, PERMISSIONS, PREDEFINED_ROLES, superAdminDefaultPermissionKeys } from "../src/rbac/permissions";
import { seed } from "../src/seed";
import { dropScratchDatabase, migrationsFolder, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0049 (Akuntansi, docs/plans/accounting.md Session 1): eight new tables, the Chart of
// Accounts (§3), the initial mappings (D-17, D-18, D-25), the PPh final setting (D-20) and three
// permissions (§7). Upgrades a database at 0048 holding real-looking data, then checks nothing
// existing changed, the reference rows equal the TS constants exactly, and re-running (the
// migrator, the migration's own INSERTs, seed.ts) changes nothing. The triggers are covered by
// accounting-ledger.test.ts.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_scratch_migration_0049";
const ACCOUNTING_KEYS = ["accounting.view", "accounting.manage", "accounting.close"];

afterAll(async () => {
  await dropScratchDatabase(SCRATCH_DATABASE);
});

/** The migration's own hand-authored INSERT statements, so re-running them can be proven a no-op. */
function referenceInsertStatements(): string[] {
  const sql = readFileSync(path.join(migrationsFolder, "0049_accounting_ledger.sql"), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .filter((part) => /INSERT INTO "(accounts|account_mappings|tax_settings|permissions|role_permissions)"/.test(part));
  expect(statements).toHaveLength(5);
  return statements;
}

type Client = ReturnType<typeof postgres>;

const accountsSql = (client: Client) => client`
  select code, name::text as name, type, normal_balance, parent_code, is_header, is_system, system_key, is_active,
         cash_flow_group, bank_name, account_no_last4, sort_order
  from accounts order by sort_order, code`;
const mappingsSql = (client: Client) => client`select mapping_key, account_code from account_mappings order by mapping_key`;
const taxSql = (client: Client) => client`
  select effective_from::text as effective_from, taxpayer_type, taxpayer_label, npwp_registered_year, rate_bps,
         annual_exemption_amount, rate_valid_until::text as rate_valid_until, note
  from tax_settings order by effective_from`;
const grantsSql = (client: Client) => client`
  select r.key as role, p.key as permission from role_permissions rp
  join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
  where p.key like 'accounting.%' order by r.key, p.key`;

function expectedAccounts() {
  return CHART_OF_ACCOUNTS.map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    normal_balance: account.normalBalance,
    parent_code: account.parentCode,
    is_header: account.isHeader,
    is_system: account.systemKey !== null,
    system_key: account.systemKey,
    is_active: true,
    cash_flow_group: account.cashFlowGroup,
    bank_name: null,
    account_no_last4: null,
    sort_order: account.sortOrder,
  }));
}

function expectedMappings() {
  return DEFAULT_ACCOUNT_MAPPINGS.map((mapping) => ({ mapping_key: mapping.mappingKey, account_code: mapping.accountCode })).sort((a, b) =>
    a.mapping_key < b.mapping_key ? -1 : 1,
  );
}

const expectedTax = [
  {
    effective_from: INITIAL_TAX_SETTING.effectiveFrom,
    taxpayer_type: INITIAL_TAX_SETTING.taxpayerType,
    taxpayer_label: INITIAL_TAX_SETTING.taxpayerLabel,
    npwp_registered_year: INITIAL_TAX_SETTING.npwpRegisteredYear,
    rate_bps: INITIAL_TAX_SETTING.rateBps,
    annual_exemption_amount: String(INITIAL_TAX_SETTING.annualExemptionAmount),
    rate_valid_until: INITIAL_TAX_SETTING.rateValidUntil,
    note: INITIAL_TAX_SETTING.note,
  },
];

describe("Chart of Accounts constants (plan §3)", () => {
  test("codes and names are unique, parents exist earlier in the list and are headers", () => {
    const codes = CHART_OF_ACCOUNTS.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);
    const names = CHART_OF_ACCOUNTS.map((account) => account.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    CHART_OF_ACCOUNTS.forEach((account, index) => {
      expect(account.code).toMatch(/^[1-9]-[0-9]{4}$/);
      // UI text rule: Indonesian names, no em dash (nor en dash used as one).
      expect(account.name).not.toMatch(/[—–]/);
      if (account.parentCode === null) return;
      const parentIndex = codes.indexOf(account.parentCode);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(index);
      expect(CHART_OF_ACCOUNTS[parentIndex]!.isHeader).toBe(true);
    });
  });

  test("system accounts are postable; system keys are unique", () => {
    const system = CHART_OF_ACCOUNTS.filter((account) => account.systemKey !== null);
    expect(system.every((account) => !account.isHeader)).toBe(true);
    const keys = system.map((account) => account.systemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("decided placements: D-16/D-7 inventory losses are beban usaha, not HPP; HPP holds only cost of sales and production residue", () => {
    const byCode = new Map(CHART_OF_ACCOUNTS.map((account) => [account.code, account]));
    for (const code of ["6-4101", "6-4102", "6-4103"]) {
      expect(byCode.get(code)).toMatchObject({ type: "expense", parentCode: "6-4000" });
    }
    expect(CHART_OF_ACCOUNTS.filter((account) => account.type === "cogs").map((account) => account.code)).toEqual(["5-1101", "5-1201"]);
    // D-6: buyer ongkir is a liability, never revenue; D-21: no PPN accounts; D-18: no credit-card payable.
    expect(byCode.get("2-1203")).toMatchObject({ type: "liability", systemKey: "liability.buyer_shipping" });
    expect(CHART_OF_ACCOUNTS.filter((account) => /ppn|kartu kredit|ongkos kirim/i.test(account.name) && account.type === "revenue")).toEqual([]);
    expect(CHART_OF_ACCOUNTS.filter((account) => /ppn|kartu kredit/i.test(account.name))).toEqual([]);
    // Contra and normal balances.
    expect(byCode.get("4-1201")).toMatchObject({ type: "contra_revenue", normalBalance: "debit" });
    expect(byCode.get("4-1301")).toMatchObject({ type: "contra_revenue", normalBalance: "debit" });
    expect(byCode.get("3-1002")).toMatchObject({ type: "equity", normalBalance: "debit" });
    for (const code of ["1-2191", "1-2192", "1-2193", "1-2194"]) expect(byCode.get(code)).toMatchObject({ type: "asset", normalBalance: "credit" });
    // D-17: exactly two cash/bank accounts today.
    expect(CHART_OF_ACCOUNTS.filter((account) => account.parentCode === "1-1100" || account.parentCode === "1-1200").map((account) => account.code)).toEqual([
      "1-1101",
      "1-1201",
    ]);
    expect(systemAccountCode("inventory.fabric")).toBe("1-1501");
    expect(() => systemAccountCode("nope.nope")).toThrow(/unknown system account key/);
  });

  test("mappings: every channel and every seeded expense category is mapped; methods follow D-17/D-18; no expense maps to inventory (D-14)", () => {
    const mapping = new Map(DEFAULT_ACCOUNT_MAPPINGS.map((row) => [row.mappingKey, row.accountCode]));
    expect(mapping.size).toBe(DEFAULT_ACCOUNT_MAPPINGS.length);
    for (const channel of CHANNEL_IDS) expect(mapping.get(`revenue.channel.${channel}`)).toMatch(/^4-11/);
    expect(mapping.get("revenue.channel.reseller")).toBe("4-1105");
    for (const category of DEFAULT_EXPENSE_CATEGORIES) expect(mapping.get(`expense.category.${category.code}`)).toMatch(/^6-/);
    expect(mapping.get("expense.category.material_shipping")).toBe("6-3101");
    expect(mapping.get("cash.method.cash")).toBe("1-1101");
    expect(mapping.get("cash.method.transfer")).toBe("1-1201");
    expect(mapping.get("cash.method.card")).toBe("1-1201");
    const postable = new Set(CHART_OF_ACCOUNTS.filter((account) => !account.isHeader).map((account) => account.code));
    for (const row of DEFAULT_ACCOUNT_MAPPINGS) {
      expect(postable.has(row.accountCode)).toBe(true);
      if (row.mappingKey.startsWith("expense.")) expect(row.accountCode.startsWith("1-15")).toBe(false);
    }
  });

  test("the accounting permissions are in the catalog; owner and super_admin get them, the finance role does not", () => {
    for (const key of ACCOUNTING_KEYS) {
      expect(PERMISSIONS.map((permission) => permission.key)).toContain(key);
      expect(superAdminDefaultPermissionKeys()).toContain(key);
      expect(ownerDefaultPermissionKeys()).toContain(key);
    }
    for (const role of PREDEFINED_ROLES) {
      expect(role.permissionKeys.filter((key) => key.startsWith("accounting."))).toEqual([]);
    }
  });
});

describe("migration 0049 (accounting ledger)", () => {
  test("upgrades a 0048 database: nothing existing changes, reference rows equal the constants, re-running is a no-op", async () => {
    await recreateScratchDatabase(SCRATCH_DATABASE);
    const client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0048 = migrationsUpTo(48);
    // Pinned to 0049 (not "latest"), so a later migration can't change what this test asserts.
    const upTo0049 = migrationsUpTo(49);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0048 });
      const [ownerRole] = await client`select id from roles where key = 'owner'`;
      // The predefined finance role (migration 0041) exists and must not gain accounting keys.
      const [financeRole] = await client`select id from roles where key = 'finance'`;
      expect(financeRole).toBeDefined();
      await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${ownerRole!.id})`;
      const snapshot = async () => ({
        roles: await client`select key, name, is_system from roles order by key`,
        permissions: await client`select key, description, "group" from permissions where key not like 'accounting.%' order by key`,
        grants: await client`
          select r.key as role, p.key as permission from role_permissions rp
          join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
          where p.key not like 'accounting.%' order by 1, 2`,
        categories: await client`select code, name::text from expense_categories order by code`,
      });
      const before = await snapshot();

      await migrate(drizzle(client), { migrationsFolder: upTo0049 });

      expect(await snapshot()).toEqual(before);
      expect(await accountsSql(client)).toEqual(expectedAccounts());
      expect(await mappingsSql(client)).toEqual(expectedMappings());
      expect(await taxSql(client)).toEqual(expectedTax);
      // Empty ledger, every month open.
      for (const table of ["journal_entries", "journal_lines", "fiscal_periods", "posting_runs", "posting_issues"]) {
        const [{ count }] = (await client.unsafe(`select count(*)::int as count from ${table}`)) as unknown as [{ count: number }];
        expect(count).toBe(0);
      }
      // Permissions: in the table with the catalog's text; granted to super_admin and owner only.
      const permissionRows = await client`select key, description, "group" from permissions where key like 'accounting.%' order by key`;
      expect(permissionRows).toEqual(
        PERMISSIONS.filter((permission) => permission.key.startsWith("accounting."))
          .map((permission) => ({ key: permission.key, description: permission.description, group: permission.group }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
      );
      const grants = await grantsSql(client);
      expect(grants).toEqual(
        ["owner", "super_admin"].flatMap((role) => [...ACCOUNTING_KEYS].sort().map((permission) => ({ role, permission }))),
      );
      // Every constraint is validated.
      const [{ invalid }] = (await client`select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
      expect(invalid).toBe(0);

      // ---- Re-running: the migrator applies nothing; the INSERTs and seed.ts change nothing, and
      // never overwrite the accountant's later edits. ----
      await client`update accounts set name = 'Bank BCA', bank_name = 'BCA', account_no_last4 = '1234' where code = '1-1201'`;
      await client`update account_mappings set account_code = '6-2901' where mapping_key = 'expense.category.packaging'`;
      await client`update tax_settings set rate_valid_until = '2029-12-31' where effective_from = '2026-12-01'`;
      await client`delete from role_permissions where role_id = ${ownerRole!.id} and permission_id = (select id from permissions where key = 'accounting.close')`;
      const accountsBefore = await accountsSql(client);
      const mappingsBefore = await mappingsSql(client);
      const taxBefore = await taxSql(client);
      const [{ count: migrationsBefore }] = (await client`select count(*)::int as count from drizzle.__drizzle_migrations`) as unknown as [{ count: number }];
      await migrate(drizzle(client), { migrationsFolder: upTo0049 });
      const [{ count: migrationsAfter }] = (await client`select count(*)::int as count from drizzle.__drizzle_migrations`) as unknown as [{ count: number }];
      expect(migrationsAfter).toBe(migrationsBefore);
      for (const statement of referenceInsertStatements().filter((part) => !part.includes('"role_permissions"'))) {
        await client.unsafe(statement);
      }
      await seed(drizzle(client));
      expect(await accountsSql(client)).toEqual(accountsBefore);
      expect(await mappingsSql(client)).toEqual(mappingsBefore);
      expect(await taxSql(client)).toEqual(taxBefore);
      expect(accountsBefore.find((row) => row.code === "1-1201")).toMatchObject({ name: "Bank BCA", bank_name: "BCA", account_no_last4: "1234" });
      // Re-running the grant restores a revoked accounting grant to owner (same as 0012/0038's
      // grants); that is the documented behaviour of these idempotent grant inserts.
      await client.unsafe(referenceInsertStatements().find((part) => part.includes('"role_permissions"'))!);
      expect(await grantsSql(client)).toEqual(grants);
    } finally {
      await client.end();
      rmSync(upTo0048, { recursive: true, force: true });
      rmSync(upTo0049, { recursive: true, force: true });
    }
  });

  test("a fresh database migrates to the same rows, and seed.ts restores them after a truncate", async () => {
    await recreateScratchDatabase(SCRATCH_DATABASE);
    const client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0049 = migrationsUpTo(49);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0049 });
      expect(await accountsSql(client)).toEqual(expectedAccounts());
      // What packages/db/test/e2e-db.ts does before every e2e run (TRUNCATE skips row triggers).
      await client.unsafe(`TRUNCATE TABLE journal_lines, journal_entries, account_mappings, accounts, tax_settings RESTART IDENTITY CASCADE`);
      expect(await accountsSql(client)).toEqual([]);
      await seed(drizzle(client));
      expect(await accountsSql(client)).toEqual(expectedAccounts());
      expect(await mappingsSql(client)).toEqual(expectedMappings());
      expect(await taxSql(client)).toEqual(expectedTax);
      // A second seed is a no-op.
      await seed(drizzle(client));
      expect(await accountsSql(client)).toEqual(expectedAccounts());
    } finally {
      await client.end();
      rmSync(upTo0049, { recursive: true, force: true });
    }
  });
});
