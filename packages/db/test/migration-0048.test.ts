import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import {
  AD_EXPENSE_CATEGORIES,
  BUSINESS_EXPENSE_CATEGORIES,
  DEFAULT_EXPENSE_CATEGORIES,
  FIXED_EXPENSE_CHANNELS,
  MARKETING_EXPENSE_CATEGORIES,
} from "../src/schema/constants";
import { seed } from "../src/seed";

// Migration 0048 (Kategori Biaya master data, docs/plans/expense-master-data.md session S1):
// expense_categories, expense_items and business_expenses.item_id; the three CHECKs over the fixed
// category list replaced by an FK and two triggers. Upgrades a database at 0047 holding expenses in
// all ten categories (one voided) and a monthly-bill choice, then checks every expense maps 1:1 and
// is untouched, the previous release's writes and verdicts are unchanged, the new rules refuse what
// they should, and re-running (the migrator, the seed INSERT, seed.ts) changes nothing.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0048_upgrade";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

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

/** The migration's own seed INSERT, so re-running it can be proven a no-op. */
function seedInsertStatement(): string {
  const sql = readFileSync(path.join(migrationsFolder, "0048_expense_master_data.sql"), "utf8");
  const statement = sql.split("--> statement-breakpoint").find((part) => part.includes('INSERT INTO "expense_categories"'));
  if (!statement) throw new Error("seed INSERT not found in 0048");
  return statement;
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

describe("seeded categories agree with the constants the app still reads", () => {
  test("codes, ad kinds, marketing kinds and fixed channels", () => {
    expect(DEFAULT_EXPENSE_CATEGORIES.map((category) => category.code)).toEqual([...BUSINESS_EXPENSE_CATEGORIES]);
    expect(DEFAULT_EXPENSE_CATEGORIES.filter((category) => category.kind === "ad").map((category) => category.code)).toEqual([...AD_EXPENSE_CATEGORIES]);
    expect(DEFAULT_EXPENSE_CATEGORIES.filter((category) => category.kind !== "operating").map((category) => category.code)).toEqual([
      ...MARKETING_EXPENSE_CATEGORIES,
    ]);
    expect(
      Object.fromEntries(DEFAULT_EXPENSE_CATEGORIES.filter((category) => category.fixedChannelId).map((category) => [category.code, category.fixedChannelId])),
    ).toEqual(FIXED_EXPENSE_CHANNELS);
  });
});

describe("migration 0048 (expense categories and items)", () => {
  test("upgrades a 0047 database: expenses map 1:1, old writes still work, new rules hold, re-running is a no-op", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0047 = migrationsUpTo(47);
    // Pinned to 0048 (not "latest"), so a later migration can't change what this test asserts.
    const upTo0048 = migrationsUpTo(48);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0047 });

      // ---- State at 0047, as the previous release leaves it. ----
      const [superRole] = await client`select id from roles where key = 'super_admin'`;
      const [staff] = await client`
        insert into staff_users (name, email, role_id, last_login_at) values ('Owner', 'owner@example.test', ${superRole!.id}, now()) returning id`;
      let fileNo = 0;
      const insertProof = async () => {
        fileNo += 1;
        const [file] = await client`
          insert into private_files (purpose, storage_key, content_type, byte_size, sha256, original_filename,
            original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
          values ('expense_proof', ${`expense_proof/2026/11/${fileNo}.jpg`}, 'image/jpeg', 412000, ${SHA_A}, 'bukti.jpg', 'image/jpeg', 3100000, ${SHA_B}, ${staff!.id})
          returning id`;
        return file!.id as string;
      };
      type Expense = { category: string; channel?: string | null; note?: string | null; campaign?: string | null };
      let expenseNo = 0;
      // The previous release's insert: it never names item_id.
      const insertExpense = async (expense: Expense) => {
        expenseNo += 1;
        const proof = await insertProof();
        return client`
          insert into business_expenses (expense_no, expense_date, category, amount, method, channel_id, campaign, note, proof_file_id, recorded_by_staff_user_id)
          values (${`BYA-202611-${String(expenseNo).padStart(3, "0")}`}, '2026-11-05', ${expense.category}, 250000, 'transfer',
                  ${expense.channel ?? null}, ${expense.campaign ?? null}, ${expense.note ?? null}, ${proof}, ${staff!.id})
          returning id`;
      };
      const existing: Expense[] = [
        { category: "ads_meta", channel: null, campaign: "Ramadan" },
        { category: "ads_tiktok", channel: "tiktok" },
        { category: "ads_shopee", channel: "shopee" },
        { category: "endorsement", channel: "instagram" },
        { category: "material_shipping" },
        { category: "packaging" },
        { category: "salary" },
        { category: "rent" },
        { category: "utilities" },
        { category: "other", note: "Servis mesin jahit" },
      ];
      for (const expense of existing) await insertExpense(expense);
      const [toVoid] = await client`select id from business_expenses where category = 'rent'`;
      await client`
        update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Dobel' where id = ${toVoid!.id}`;
      await client`update sales_goal set monthly_bill_categories = '{salary,rent}' where id = 1`;

      const expensesSql = () => client`select to_jsonb(e) - 'item_id' as row from business_expenses e order by expense_no`;
      const expensesBefore = await expensesSql();

      await migrate(drizzle(client), { migrationsFolder: upTo0048 });

      // ---- Reference rows: exactly DEFAULT_EXPENSE_CATEGORIES, all active. ----
      const categoriesSql = () => client`
        select code, name::text as name, kind, fixed_channel_id, is_system, is_active, sort_order
        from expense_categories order by sort_order, code`;
      const categories = await categoriesSql();
      expect(categories).toEqual(
        DEFAULT_EXPENSE_CATEGORIES.map((category) => ({
          code: category.code,
          name: category.name,
          kind: category.kind,
          fixed_channel_id: category.fixedChannelId,
          is_system: category.isSystem,
          is_active: true,
          sort_order: category.sortOrder,
        })),
      );

      // ---- Existing expenses: untouched, no item, every one maps to its category 1:1. ----
      expect(await expensesSql()).toEqual(expensesBefore);
      const [{ withItem }] = (await client`select count(*)::int as "withItem" from business_expenses where item_id is not null`) as unknown as [{ withItem: number }];
      expect(withItem).toBe(0);
      const mapped = await client`
        select e.category, c.code from business_expenses e left join expense_categories c on c.code = e.category order by e.expense_no`;
      expect(mapped.map((row) => row.code)).toEqual(existing.map((expense) => expense.category));
      const [goal] = await client`select monthly_bill_categories from sales_goal where id = 1`;
      expect(goal!.monthly_bill_categories).toEqual(["salary", "rent"]);

      // ---- The fixed-list CHECKs are gone; every remaining constraint is validated. ----
      const constraintNames = (await client`select conname from pg_constraint`).map((row) => row.conname as string);
      for (const name of ["business_expenses_category_check", "business_expenses_channel_check", "sales_goal_monthly_bill_categories_allowed_check"]) {
        expect(constraintNames).not.toContain(name);
      }
      const [{ invalid }] = (await client`select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
      expect(invalid).toBe(0);

      // ---- The previous release's writes keep working, with the dropped CHECKs' verdicts. ----
      for (const expense of existing) await insertExpense(expense);
      await insertExpense({ category: "ads_meta", channel: "web" });
      await insertExpense({ category: "endorsement", channel: null });
      const [oldRow] = await insertExpense({ category: "packaging" });
      const voided = await client`
        update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Salah nominal'
        where id = ${oldRow!.id} and voided_at is null returning id`;
      expect(voided).toHaveLength(1);
      await expect(insertExpense({ category: "ads_shopee", channel: null })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "ads_shopee", channel: "tiktok" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "ads_tiktok", channel: "shopee" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "salary", channel: "web" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "ads_meta", channel: "nowhere" })).rejects.toThrow(/business_expenses_channel_id_channels_id_fk/);
      await expect(insertExpense({ category: "gift" })).rejects.toThrow(/business_expenses_category_expense_categories_code_fk/);
      await expect(insertExpense({ category: "other" })).rejects.toThrow(/business_expenses_other_note_check/);
      await expect(insertExpense({ category: "salary", campaign: "  " })).rejects.toThrow(/business_expenses_campaign_check/);
      // The trigger reports the old constraint name in the error fields too.
      const channelError = await insertExpense({ category: "salary", channel: "web" }).catch((error: unknown) => error);
      expect(channelError).toMatchObject({ code: "23514", constraint_name: "business_expenses_channel_check", table_name: "business_expenses" });
      // The previous release's monthly-bill save (salary/rent/utilities) and goal upsert.
      await client`update sales_goal set monthly_bill_categories = '{rent,salary,utilities}' where id = 1`;
      await client`
        insert into sales_goal (id, revenue_target_amount, start_date) values (1, 900000000, '2026-11-01')
        on conflict (id) do update set revenue_target_amount = excluded.revenue_target_amount, start_date = excluded.start_date`;

      // ---- expense_categories: the new rules. ----
      await client`insert into expense_categories (code, name, kind, sort_order) values ('langganan', 'Langganan', 'operating', 160)`;
      await client`insert into expense_categories (code, name, kind, sort_order) values ('iklan_google', 'Iklan Google', 'ad', 50)`;
      const insertCategory = (code: string, name: string, kind = "operating", fixedChannel: string | null = null, isSystem = false) =>
        client`insert into expense_categories (code, name, kind, fixed_channel_id, is_system) values (${code}, ${name}, ${kind}, ${fixedChannel}, ${isSystem})`;
      await expect(insertCategory("biaya_produksi", "Produksi lain")).rejects.toThrow(/expense_categories_code_check/);
      await expect(insertCategory("produksi", "Biaya produksi")).rejects.toThrow(/expense_categories_name_check/);
      await expect(insertCategory("produksi", "  biaya PRODUKSI ")).rejects.toThrow(/expense_categories_name_check/);
      await expect(insertCategory("produksi", "Biaya  produksi")).rejects.toThrow(/expense_categories_name_check/);
      await expect(insertCategory("produksi", "Biaya\tproduksi")).rejects.toThrow(/expense_categories_name_check/);
      // Only the exact label is reserved, not names that merely contain it.
      await insertCategory("biaya_produksi_lain", "Biaya produksi lain");
      await expect(insertCategory("gaji_2", "gaji")).rejects.toThrow(/expense_categories_name_unique/);
      await expect(insertCategory("Langganan_2", "Langganan 2")).rejects.toThrow(/expense_categories_code_check/);
      await expect(insertCategory("blank", "   ")).rejects.toThrow(/expense_categories_name_check/);
      await expect(insertCategory("long", "x".repeat(61))).rejects.toThrow(/expense_categories_name_check/);
      await expect(insertCategory("gift", "Hadiah", "gift")).rejects.toThrow(/expense_categories_kind_check/);
      await expect(insertCategory("iklan_web", "Iklan Web", "ad", "web")).rejects.toThrow(/expense_categories_fixed_channel_check/);
      await expect(insertCategory("sewa_toko", "Sewa toko", "operating", "web", true)).rejects.toThrow(/expense_categories_fixed_channel_check/);
      // System categories: renamed fine, never deactivated, identity fixed.
      await client`update expense_categories set name = 'Iklan Facebook & Instagram', sort_order = 5 where code = 'ads_meta'`;
      await expect(client`update expense_categories set is_active = false where code = 'ads_shopee'`).rejects.toThrow(/expense_categories_system_active_check/);
      await expect(client`update expense_categories set is_active = false where code = 'other'`).rejects.toThrow(/expense_categories_system_active_check/);
      await expect(client`update expense_categories set code = 'iklan_shopee' where code = 'ads_shopee'`).rejects.toThrow(/immutable/);
      await expect(client`update expense_categories set kind = 'operating' where code = 'ads_meta'`).rejects.toThrow(/immutable/);
      await expect(client`update expense_categories set fixed_channel_id = null where code = 'ads_tiktok'`).rejects.toThrow(/immutable/);
      await expect(client`update expense_categories set is_system = false where code = 'other'`).rejects.toThrow(/immutable/);
      // Non-system: identity fixed too, but deactivation and reactivation are fine.
      await expect(client`update expense_categories set kind = 'ad' where code = 'langganan'`).rejects.toThrow(/immutable/);
      await expect(client`update expense_categories set code = 'subscriptions' where code = 'langganan'`).rejects.toThrow(/immutable/);
      await expect(client`update expense_categories set is_system = true where code = 'langganan'`).rejects.toThrow(/immutable/);
      await client`update expense_categories set is_active = false where code = 'utilities'`;
      await client`update expense_categories set is_active = true where code = 'utilities'`;
      const [stamped] = await client`
        update expense_categories set updated_at = '2000-01-01', name = 'Langganan' where code = 'langganan' returning updated_at`;
      expect(new Date(stamped!.updated_at as string).getUTCFullYear()).toBeGreaterThan(2000);
      // Never deleted, used or not.
      await expect(client`delete from expense_categories where code = 'iklan_google'`).rejects.toThrow(/never deleted/);
      await expect(client`delete from expense_categories where code = 'salary'`).rejects.toThrow(/never deleted/);

      // ---- The channel rule for categories that did not exist before 0048. ----
      await insertExpense({ category: "iklan_google", channel: "web" });
      await insertExpense({ category: "iklan_google", channel: null });
      await insertExpense({ category: "langganan", channel: null });
      await expect(insertExpense({ category: "langganan", channel: "web" })).rejects.toThrow(/business_expenses_channel_check/);

      // ---- expense_items ----
      const insertItem = (category: string, name: string, defaultAmount: number | null = null, note: string | null = null) =>
        client`
          insert into expense_items (category_code, name, default_amount, note) values (${category}, ${name}, ${defaultAmount}, ${note})
          returning id`;
      const [vps] = await insertItem("langganan", "VPS", 350000, "Server toko online");
      const [biteship] = await insertItem("langganan", "Biteship Grow");
      const [liveAds] = await insertItem("ads_shopee", "Iklan Live");
      // The same name in another category is a different item.
      await insertItem("other", "VPS");
      await expect(insertItem("langganan", "vps")).rejects.toThrow(/expense_items_category_code_name_key/);
      await expect(insertItem("langganan", "  ")).rejects.toThrow(/expense_items_name_check/);
      await expect(insertItem("langganan", "x".repeat(81))).rejects.toThrow(/expense_items_name_check/);
      await expect(insertItem("langganan", "Claude", 0)).rejects.toThrow(/expense_items_default_amount_check/);
      await expect(insertItem("langganan", "Claude", 1_000_000_001)).rejects.toThrow(/expense_items_default_amount_check/);
      await expect(insertItem("langganan", "Claude", null, " ")).rejects.toThrow(/expense_items_note_check/);
      await expect(insertItem("gift", "Claude")).rejects.toThrow(/expense_items_category_code_expense_categories_code_fk/);
      await client`update expense_items set name = 'VPS Biznet', default_amount = 400000, sort_order = 2, is_active = false where id = ${vps!.id}`;
      await client`update expense_items set is_active = true where id = ${vps!.id}`;
      await expect(client`update expense_items set category_code = 'other' where id = ${biteship!.id}`).rejects.toThrow(/category_code is immutable/);
      await expect(client`delete from expense_items where id = ${biteship!.id}`).rejects.toThrow(/never deleted/);

      // ---- business_expenses.item_id: the item must be in the expense's own category. ----
      const insertWithItem = async (category: string, itemId: string, channel: string | null = null) => {
        expenseNo += 1;
        const proof = await insertProof();
        return client`
          insert into business_expenses (expense_no, expense_date, category, item_id, amount, method, channel_id, proof_file_id, recorded_by_staff_user_id)
          values (${`BYA-202611-${String(expenseNo).padStart(3, "0")}`}, '2026-11-06', ${category}, ${itemId}, 350000, 'card', ${channel}, ${proof}, ${staff!.id})
          returning id`;
      };
      const [withVps] = await insertWithItem("langganan", vps!.id);
      await insertWithItem("ads_shopee", liveAds!.id, "shopee");
      await expect(insertWithItem("salary", vps!.id)).rejects.toThrow(/business_expenses_item_category_fk/);
      await expect(insertWithItem("langganan", liveAds!.id)).rejects.toThrow(/business_expenses_item_category_fk/);
      await expect(insertWithItem("langganan", "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/business_expenses_item_category_fk/);
      // Still append-only: the item can't be changed afterwards, but the void stamp can be set.
      await expect(client`update business_expenses set item_id = ${biteship!.id} where id = ${withVps!.id}`).rejects.toThrow(/append-only/);
      await expect(client`update business_expenses set item_id = null where id = ${withVps!.id}`).rejects.toThrow(/append-only/);
      const voidedWithItem = await client`
        update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Salah item'
        where id = ${withVps!.id} and voided_at is null returning id`;
      expect(voidedWithItem).toHaveLength(1);
      await expect(client`delete from business_expenses where id = ${withVps!.id}`).rejects.toThrow(/never deleted/);

      // ---- Monthly bills: any known category; never an unknown one or a duplicate. ----
      await client`update sales_goal set monthly_bill_categories = '{salary,langganan}' where id = 1`;
      await expect(client`update sales_goal set monthly_bill_categories = '{salary,gift}' where id = 1`).rejects.toThrow(
        /sales_goal_monthly_bill_categories_known/,
      );
      await expect(client`update sales_goal set monthly_bill_categories = '{langganan,langganan}' where id = 1`).rejects.toThrow(
        /sales_goal_monthly_bill_categories_no_duplicates_check/,
      );
      // An update that leaves the column alone is not re-checked (and the stored value is valid).
      await client`update sales_goal set revenue_target_amount = 1100000000 where id = 1`;

      // ---- Re-running: the migrator applies nothing, the seed INSERT and seed.ts change nothing. ----
      const categoriesBeforeRerun = await categoriesSql();
      const [{ count: migrationsBefore }] = (await client`select count(*)::int as count from drizzle.__drizzle_migrations`) as unknown as [{ count: number }];
      await migrate(drizzle(client), { migrationsFolder: upTo0048 });
      const [{ count: migrationsAfter }] = (await client`select count(*)::int as count from drizzle.__drizzle_migrations`) as unknown as [{ count: number }];
      expect(migrationsAfter).toBe(migrationsBefore);
      await client.unsafe(seedInsertStatement());
      // seed.ts is always the current code and writes tables later migrations add (0049:
      // accounts), so it runs against the latest schema; no later migration touches categories.
      await migrate(drizzle(client), { migrationsFolder });
      await seed(drizzle(client));
      expect(await categoriesSql()).toEqual(categoriesBeforeRerun);
      expect(categoriesBeforeRerun.find((row) => row.code === "ads_meta")!.name).toBe("Iklan Facebook & Instagram");
    } finally {
      await client.end();
      rmSync(upTo0047, { recursive: true, force: true });
      rmSync(upTo0048, { recursive: true, force: true });
    }
  });

  test("a fresh database migrates to the same ten categories, and seed.ts restores them after a truncate", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0048 = migrationsUpTo(48);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0048 });
      const codes = async () => (await client`select code from expense_categories order by sort_order`).map((row) => row.code as string);
      expect(await codes()).toEqual(DEFAULT_EXPENSE_CATEGORIES.map((category) => category.code));
      // What packages/db/test/e2e-db.ts does before every e2e run (TRUNCATE skips row triggers).
      await client.unsafe(`TRUNCATE TABLE expense_items, expense_categories RESTART IDENTITY CASCADE`);
      expect(await codes()).toEqual([]);
      // As above: the current seed.ts needs the current schema.
      await migrate(drizzle(client), { migrationsFolder });
      await seed(drizzle(client));
      expect(await codes()).toEqual(DEFAULT_EXPENSE_CATEGORIES.map((category) => category.code));
    } finally {
      await client.end();
      rmSync(upTo0048, { recursive: true, force: true });
    }
  });
});
