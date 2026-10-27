import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { PERMISSIONS, PREDEFINED_ROLES } from "../src/rbac/permissions";

// Migration 0042 (Pertumbuhan, docs/plans/growth.md §11): business_expenses (append-only, proof
// required), voucher_adjustments (immutable), the private_files purpose widen, customers.manage /
// customers.export, and two permission description updates. Upgrades a database sitting at 0041
// that already holds a supplier payment proof and a voucher, then checks the previous release's
// writes, every new constraint and trigger, the grants (including the CS role an admin edited),
// and that re-running the migrator is a no-op.
//
// Runs against disposable databases of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0042_upgrade";

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

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("migration 0042 (Pertumbuhan: expenses, voucher adjustments, customer permissions)", () => {
  test("upgrades a 0041 database, keeps the previous release's writes working, and enforces the new rules", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0041 = migrationsUpTo(41);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0041 });

      // ---- State at 0041, as the previous release leaves it. ----
      const [superRole] = await client`select id from roles where key = 'super_admin'`;
      const [staff] = await client`
        insert into staff_users (name, email, role_id, last_login_at) values ('Owner', 'owner@example.test', ${superRole!.id}, now()) returning id`;
      const insertFile = (purpose: string, key: string) =>
        client`
          insert into private_files (purpose, storage_key, content_type, byte_size, sha256, original_filename,
            original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
          values (${purpose}, ${key}, 'image/jpeg', 412000, ${SHA_A}, 'bukti.jpg', 'image/jpeg', 3100000, ${SHA_B}, ${staff!.id})
          returning id`;
      await insertFile("payment_proof", "payment_proof/2026/10/old.jpg");
      const [customer] = await client`insert into customers (email, name) values ('pembeli@example.com', 'Pembeli') returning id`;
      const [order] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, customer_id)
        values ('web', 'ORD-202610-0001', now(), 'completed', 269000, 0, 0, 269000, ${customer!.id}) returning id`;
      const [card] = await client`
        insert into thank_you_cards (order_id, token_hash, status, claim_deadline, printed_by_staff_user_id, claimed_by_customer_id, claimed_at)
        values (${order!.id}, ${SHA_A}, 'claimed', now() + interval '30 days', ${staff!.id}, ${customer!.id}, now()) returning id`;
      const [voucher] = await client`
        insert into vouchers (card_id, customer_id, expires_at) values (${card!.id}, ${customer!.id}, now() + interval '90 days') returning id, expires_at`;

      await migrate(drizzle(client), { migrationsFolder });

      // ---- Reference data. ----
      expect(await grantsOf(client, "super_admin")).toEqual(expect.arrayContaining(["customers.manage", "customers.export"]));
      const ownerGrants = await grantsOf(client, "owner");
      expect(ownerGrants).toEqual(expect.arrayContaining(["customers.manage", "customers.export"]));
      // CS still holds customers.view as shipped by 0041, so it gains customers.manage only.
      const csGrants = await grantsOf(client, "customer_service");
      expect(csGrants).toContain("customers.manage");
      expect(csGrants).not.toContain("customers.export");
      expect(csGrants).not.toContain("vouchers.void");
      for (const roleKey of ["finance", "packing_warehouse", "content_admin"]) {
        const grants = await grantsOf(client, roleKey);
        expect(grants).not.toContain("customers.manage");
        expect(grants).not.toContain("customers.export");
      }
      // The migrated predefined CS role is exactly PREDEFINED_ROLES' (what a fresh seed gives).
      const csDefinition = PREDEFINED_ROLES.find((role) => role.key === "customer_service")!;
      expect(csGrants).toEqual([...csDefinition.permissionKeys].sort());
      // The keys this migration inserts or re-describes match the catalog (other keys' descriptions
      // are seed.ts's business; some older migrations shipped shorter wording).
      const descriptions = new Map(
        (await client<{ key: string; description: string }[]>`select key, description from permissions`).map((row) => [row.key, row.description]),
      );
      for (const key of ["customers.manage", "customers.export", "vouchers.void", "ads_expenses.manage"]) {
        expect(descriptions.get(key)).toBe(PERMISSIONS.find((permission) => permission.key === key)!.description);
      }

      // ---- The previous release's writes keep working. ----
      await insertFile("payment_proof", "payment_proof/2026/10/new.jpg");
      await insertFile("purchase_invoice", "purchase_invoice/2026/10/new.pdf");
      await client`update vouchers set status = 'used', used_order_id = ${order!.id}, used_at = now() where id = ${voucher!.id}`;
      await client`update vouchers set status = 'active', used_order_id = null, used_at = null where id = ${voucher!.id}`;

      // ---- private_files: the widened purpose CHECK. ----
      const [expenseProof] = await insertFile("expense_proof", "expense_proof/2026/10/1.jpg");
      const [expenseProof2] = await insertFile("expense_proof", "expense_proof/2026/10/2.jpg");
      const [expenseProof3] = await insertFile("expense_proof", "expense_proof/2026/10/3.jpg");
      const [paymentProof] = await insertFile("payment_proof", "payment_proof/2026/10/3.jpg");
      await expect(insertFile("receipt", "x/1.jpg")).rejects.toThrow(/private_files_purpose_check/);

      // ---- business_expenses ----
      type ExpenseOverrides = { category?: string; channel?: string | null; note?: string | null; campaign?: string | null; amount?: number; method?: string; file?: string; no?: string };
      const insertExpense = (o: ExpenseOverrides = {}) =>
        client`
          insert into business_expenses (expense_no, expense_date, category, amount, method, channel_id, campaign, note, proof_file_id, recorded_by_staff_user_id)
          values (${o.no ?? "BYA-202610-001"}, '2026-10-05', ${o.category ?? "ads_shopee"}, ${o.amount ?? 500000}, ${o.method ?? "transfer"},
                  ${o.channel === undefined ? "shopee" : o.channel}, ${o.campaign ?? null}, ${o.note ?? null}, ${o.file ?? expenseProof!.id}, ${staff!.id})
          returning id`;

      // Channel rules: Shopee/TikTok ads name their own channel, Meta/endorse may name one,
      // operating costs never do.
      await expect(insertExpense({ channel: null })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ channel: "tiktok" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "ads_tiktok", channel: "shopee" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "salary", channel: "web" })).rejects.toThrow(/business_expenses_channel_check/);
      await expect(insertExpense({ category: "ads_meta", channel: "nowhere" })).rejects.toThrow(/business_expenses_channel_id_channels_id_fk/);
      // Other CHECKs.
      await expect(insertExpense({ amount: 0 })).rejects.toThrow(/business_expenses_amount_check/);
      await expect(insertExpense({ method: "cheque" })).rejects.toThrow(/business_expenses_method_check/);
      await expect(insertExpense({ category: "gift", channel: null })).rejects.toThrow(/business_expenses_category_check/);
      await expect(insertExpense({ category: "other", channel: null })).rejects.toThrow(/business_expenses_other_note_check/);
      await expect(insertExpense({ category: "other", channel: null, note: "   " })).rejects.toThrow(/business_expenses_note_check/);
      await expect(insertExpense({ campaign: "  " })).rejects.toThrow(/business_expenses_campaign_check/);
      await expect(insertExpense({ campaign: "x".repeat(121) })).rejects.toThrow(/business_expenses_campaign_check/);
      // A supplier payment's proof can never be filed as an expense proof.
      await expect(insertExpense({ file: paymentProof!.id })).rejects.toThrow(/business_expenses_proof_file_fk/);

      const [expense] = await insertExpense({ campaign: "Promo 11.11" });
      await insertExpense({ no: "BYA-202610-002", category: "ads_meta", channel: null, file: expenseProof2!.id });
      await insertExpense({ no: "BYA-202610-003", category: "other", channel: null, note: "Servis mesin jahit", file: expenseProof3!.id });
      // One proof belongs to one expense; one number to one expense.
      const [expenseProof4] = await insertFile("expense_proof", "expense_proof/2026/10/4.jpg");
      await expect(insertExpense({ no: "BYA-202610-009" })).rejects.toThrow(/business_expenses_proof_file_id_unique/);
      await expect(insertExpense({ file: expenseProof4!.id })).rejects.toThrow(/business_expenses_expense_no_unique/);

      // Append-only: no edit, no delete; void once, all three columns with a reason.
      await expect(client`update business_expenses set amount = 1 where id = ${expense!.id}`).rejects.toThrow(/append-only/);
      await expect(client`update business_expenses set expense_date = '2026-10-06' where id = ${expense!.id}`).rejects.toThrow(/append-only/);
      await expect(client`delete from business_expenses where id = ${expense!.id}`).rejects.toThrow(/never deleted/);
      await expect(client`update business_expenses set voided_at = now() where id = ${expense!.id}`).rejects.toThrow(
        /business_expenses_voided_triple_check/,
      );
      await expect(
        client`update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = '  ' where id = ${expense!.id}`,
      ).rejects.toThrow(/business_expenses_voided_triple_check/);
      const voided = await client`
        update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Salah nominal'
        where id = ${expense!.id} and voided_at is null returning id`;
      expect(voided).toHaveLength(1);
      await expect(client`update business_expenses set void_reason = 'Lain' where id = ${expense!.id}`).rejects.toThrow(/already been voided/);
      const again = await client`
        update business_expenses set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Lagi'
        where id = ${expense!.id} and voided_at is null returning id`;
      expect(again).toHaveLength(0);
      // The proof file itself stays immutable.
      await expect(client`delete from private_files where id = ${expenseProof!.id}`).rejects.toThrow(/immutable/);

      // ---- voucher_adjustments ----
      const previousExpiry = new Date(voucher!.expires_at as string | Date);
      const insertAdjustment = (kind: string, newExpiresAt: Date | null, reason = "Permintaan pelanggan") =>
        client`
          insert into voucher_adjustments (voucher_id, kind, previous_status, previous_expires_at, new_expires_at, reason, staff_user_id)
          values (${voucher!.id}, ${kind}, 'active', ${previousExpiry.toISOString()}, ${newExpiresAt?.toISOString() ?? null}, ${reason}, ${staff!.id}) returning id`;
      const later = new Date(previousExpiry.getTime() + 30 * 86_400_000);
      const earlier = new Date(previousExpiry.getTime() - 86_400_000);
      await expect(insertAdjustment("extend", null)).rejects.toThrow(/voucher_adjustments_new_expires_at_check/);
      await expect(insertAdjustment("extend", earlier)).rejects.toThrow(/voucher_adjustments_new_expires_at_check/);
      await expect(insertAdjustment("void", later)).rejects.toThrow(/voucher_adjustments_new_expires_at_check/);
      await expect(insertAdjustment("refund", null)).rejects.toThrow(/voucher_adjustments_kind_check/);
      await expect(insertAdjustment("void", null, "  ")).rejects.toThrow(/voucher_adjustments_reason_check/);
      const [adjustment] = await insertAdjustment("extend", later);
      await insertAdjustment("void", null, "Kartu ganda");
      await expect(client`update voucher_adjustments set reason = 'x' where id = ${adjustment!.id}`).rejects.toThrow(/append-only/);
      await expect(client`delete from voucher_adjustments where id = ${adjustment!.id}`).rejects.toThrow(/append-only/);
      await expect(client`delete from vouchers where id = ${voucher!.id}`).rejects.toThrow(/voucher_adjustments_voucher_id_vouchers_id_fk/);

      // ---- Re-running the migrator applies nothing and changes nothing. ----
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
      expect(await grantsOf(client, "customer_service")).toEqual(csGrants);
    } finally {
      await client.end();
      rmSync(upTo0041, { recursive: true, force: true });
    }
  });

  test("leaves a CS role alone when an admin has taken customer access away from it", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0041 = migrationsUpTo(41);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0041 });
      await client`
        delete from role_permissions
        where role_id = (select id from roles where key = 'customer_service')
          and permission_id = (select id from permissions where key = 'customers.view')`;
      const edited = await grantsOf(client, "customer_service");

      await migrate(drizzle(client), { migrationsFolder });

      expect(await grantsOf(client, "customer_service")).toEqual(edited);
    } finally {
      await client.end();
      rmSync(upTo0041, { recursive: true, force: true });
    }
  });
});
