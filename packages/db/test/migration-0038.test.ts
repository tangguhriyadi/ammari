import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0038 (supplier payments with mandatory proof, docs/plans/purchase-payments.md §4):
// adds private_files, supplier_payments and purchase_attachments (all append-only by trigger),
// a (id, supplier_id) unique key on purchases, and the supplier_payments.manage permission.
// Upgrades a database sitting at 0037 with a purchase and two batches, then checks the previous
// release's writes keep working, every new constraint and trigger, and that re-running the
// migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0038_upgrade";

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

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("migration 0038 (supplier payments)", () => {
  test("upgrades a database at 0037, keeps the previous release's writes working, and enforces append-only payments", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0037 = migrationsUpTo(37);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0037 });

      // ---- State at 0037, as the previous release leaves it. ----
      const upsertRole = (key: string, isSystem: boolean) =>
        client`insert into roles (key, name, is_system) values (${key}, ${key}, ${isSystem})
               on conflict (key) do update set name = excluded.name returning id`;
      const [superAdmin] = await upsertRole("super_admin", true);
      await upsertRole("owner", true);
      await upsertRole("packer", false);
      const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${superAdmin!.id}) returning id`;
      const [supplierA] = await client`insert into suppliers (name) values ('Toko Kain A') returning id`;
      const [supplierB] = await client`insert into suppliers (name) values ('Penjahit B') returning id`;
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [purchase] = await client`
        insert into purchases (purchase_no, supplier_id, ordered_at, created_by_staff_user_id)
        values ('PO-202610-001', ${supplierA!.id}, '2026-10-01', ${staff!.id}) returning id`;
      const [otherPurchase] = await client`
        insert into purchases (purchase_no, supplier_id, ordered_at, created_by_staff_user_id)
        values ('PO-202610-002', ${supplierA!.id}, '2026-10-02', ${staff!.id}) returning id`;
      const [postedBatch] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, status, posted_at, posted_by_staff_user_id)
        values (${fabric!.id}, 'B-202610-001', '2026-10-03', 'posted', now(), ${staff!.id}) returning id`;
      const [draftBatch] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at) values (${fabric!.id}, 'B-202610-002', '2026-10-04') returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      // ---- Reference data: the permission, granted to super_admin and owner only (of the
      // system roles: this migrates to the latest schema, where migration 0041's predefined
      // Keuangan role holds it too). ----
      const grants = await client`
        select r.key from role_permissions rp
        join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key = 'supplier_payments.manage' and r.is_system order by r.key`;
      expect(grants.map((row) => row.key)).toEqual(["owner", "super_admin"]);
      const [permission] = await client`select "group" from permissions where key = 'supplier_payments.manage'`;
      expect(permission).toEqual({ group: "finance" });

      // ---- Existing purchases/batches read as "no payments"; the previous release still works. ----
      const [{ count: paymentCount }] = (await client`select count(*)::int as count from supplier_payments`) as unknown as [
        { count: number },
      ];
      expect(paymentCount).toBe(0);
      await client`update purchases set notes = 'dicek', updated_at = now() where id = ${purchase!.id}`;
      // Changing the supplier of a purchase that has no payment is still the previous release's
      // ordinary edit.
      await client`update purchases set supplier_id = ${supplierB!.id} where id = ${otherPurchase!.id}`;
      await client`update purchases set supplier_id = ${supplierA!.id} where id = ${otherPurchase!.id}`;
      await client`
        insert into purchases (purchase_no, supplier_id, ordered_at) values ('PO-202610-003', ${supplierB!.id}, '2026-10-05')`;
      await client`update production_batches set notes = 'draft diubah' where id = ${draftBatch!.id}`;

      // ---- private_files ----
      const insertFile = (purpose: string, key: string, contentType = "image/jpeg") =>
        client`
          insert into private_files (purpose, storage_key, content_type, byte_size, sha256, original_filename,
            original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
          values (${purpose}, ${key}, ${contentType}, 412000, ${SHA_A}, 'IMG_0001.HEIC.jpg', 'image/jpeg', 3100000, ${SHA_B}, ${staff!.id})
          returning id`;
      const [proof1] = await insertFile("payment_proof", "payment_proof/2026/10/1.jpg");
      const [proof2] = await insertFile("payment_proof", "payment_proof/2026/10/2.jpg", "application/pdf");
      const [proof3] = await insertFile("payment_proof", "payment_proof/2026/10/3.jpg");
      const [invoice] = await insertFile("purchase_invoice", "purchase_invoice/2026/10/1.pdf", "application/pdf");

      await expect(insertFile("receipt", "x/1.jpg")).rejects.toThrow(/private_files_purpose_check/);
      await expect(insertFile("payment_proof", "x/2.png", "image/png")).rejects.toThrow(/private_files_content_type_check/);
      await expect(insertFile("payment_proof", "payment_proof/2026/10/1.jpg")).rejects.toThrow(/private_files_storage_key_unique/);
      await expect(
        client`
          insert into private_files (purpose, storage_key, content_type, byte_size, sha256, original_filename,
            original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
          values ('payment_proof', 'k/3.jpg', 'image/jpeg', 1, 'NOT-A-HASH', 'a.jpg', 'image/jpeg', 1, ${SHA_B}, ${staff!.id})`,
      ).rejects.toThrow(/private_files_sha256_check/);
      await expect(
        client`
          insert into private_files (purpose, storage_key, content_type, byte_size, sha256, original_filename,
            original_content_type, original_byte_size, original_sha256, uploaded_by_staff_user_id)
          values ('payment_proof', 'k/4.jpg', 'image/jpeg', 0, ${SHA_A}, 'a.jpg', 'image/jpeg', 1, ${SHA_B}, ${staff!.id})`,
      ).rejects.toThrow(/private_files_byte_size_check/);
      await expect(client`update private_files set storage_key = 'moved.jpg' where id = ${proof1!.id}`).rejects.toThrow(/immutable/);
      await expect(client`delete from private_files where id = ${proof1!.id}`).rejects.toThrow(/immutable/);

      // ---- supplier_payments: a DP against the purchase, payee = the purchase's supplier. ----
      let paymentSeq = 0;
      const insertPurchasePayment = (fileId: string, supplierId: string | null, amount = 300_000, method = "transfer") =>
        client`
          insert into supplier_payments (payment_no, target_type, purchase_id, supplier_id, supplier_name, paid_at, amount, method,
            proof_file_id, recorded_by_staff_user_id)
          values (${`BYR-202610-${String(++paymentSeq).padStart(3, "0")}`}, 'purchase', ${purchase!.id}, ${supplierId}, ${supplierId ? "Toko Kain A" : null},
            '2026-10-06', ${amount}, ${method}, ${fileId}, ${staff!.id})
          returning id`;
      const [payment] = await insertPurchasePayment(proof1!.id, supplierA!.id);

      // The payee is pinned to the purchase's own supplier, and is required for a purchase.
      await expect(insertPurchasePayment(proof2!.id, supplierB!.id)).rejects.toThrow(/supplier_payments_purchase_supplier_fk/);
      await expect(insertPurchasePayment(proof2!.id, null)).rejects.toThrow(/supplier_payments_purchase_payee_check/);
      // Amount and method.
      await expect(insertPurchasePayment(proof2!.id, supplierA!.id, 0)).rejects.toThrow(/supplier_payments_amount_check/);
      await expect(insertPurchasePayment(proof2!.id, supplierA!.id, 1000, "card")).rejects.toThrow(/supplier_payments_method_check/);
      // One proof file per payment, and a nota can't be filed as a proof.
      await expect(insertPurchasePayment(proof1!.id, supplierA!.id)).rejects.toThrow(/supplier_payments_proof_file_id_unique/);
      await expect(insertPurchasePayment(invoice!.id, supplierA!.id)).rejects.toThrow(/supplier_payments_proof_file_fk/);
      // The proof is required.
      await expect(
        client`
          insert into supplier_payments (payment_no, target_type, purchase_id, supplier_id, supplier_name, paid_at, amount, method, recorded_by_staff_user_id)
          values ('BYR-202610-900', 'purchase', ${purchase!.id}, ${supplierA!.id}, 'Toko Kain A', '2026-10-06', 1000, 'cash', ${staff!.id})`,
      ).rejects.toThrow(/null value in column "proof_file_id"/);
      // Exactly one target, agreeing with target_type.
      await expect(
        client`
          insert into supplier_payments (payment_no, target_type, purchase_id, production_batch_id, supplier_id, supplier_name, paid_at, amount,
            method, proof_file_id, recorded_by_staff_user_id)
          values ('BYR-202610-901', 'purchase', ${purchase!.id}, ${postedBatch!.id}, ${supplierA!.id}, 'Toko Kain A', '2026-10-06', 1000,
            'cash', ${proof2!.id}, ${staff!.id})`,
      ).rejects.toThrow(/supplier_payments_exactly_one_target_check/);
      await expect(
        client`
          insert into supplier_payments (payment_no, target_type, production_batch_id, paid_at, amount, method, proof_file_id, recorded_by_staff_user_id)
          values ('BYR-202610-902', 'purchase', ${postedBatch!.id}, '2026-10-06', 1000, 'cash', ${proof2!.id}, ${staff!.id})`,
      ).rejects.toThrow(/supplier_payments_exactly_one_target_check/);
      // Supplier and name snapshot travel together.
      await expect(
        client`
          insert into supplier_payments (payment_no, target_type, production_batch_id, supplier_id, paid_at, amount, method, proof_file_id,
            recorded_by_staff_user_id)
          values ('BYR-202610-903', 'production_batch', ${postedBatch!.id}, ${supplierB!.id}, '2026-10-06', 1000, 'cash', ${proof2!.id}, ${staff!.id})`,
      ).rejects.toThrow(/supplier_payments_supplier_pair_check/);
      // A batch payment may name a payee, or none for the lines nobody attributed.
      await client`
        insert into supplier_payments (payment_no, target_type, production_batch_id, supplier_id, supplier_name, paid_at, amount, method,
          proof_file_id, recorded_by_staff_user_id)
        values ('BYR-202610-904', 'production_batch', ${postedBatch!.id}, ${supplierB!.id}, 'Penjahit B', '2026-10-06', 150000, 'cash',
          ${proof2!.id}, ${staff!.id})`;
      await client`
        insert into supplier_payments (payment_no, target_type, production_batch_id, paid_at, amount, method, proof_file_id, recorded_by_staff_user_id)
        values ('BYR-202610-905', 'production_batch', ${postedBatch!.id}, '2026-10-06', 25000, 'cash', ${proof3!.id}, ${staff!.id})`;
      await expect(
        client`
          insert into supplier_payments (payment_no, target_type, purchase_id, supplier_id, supplier_name, paid_at, amount, method,
            proof_file_id, recorded_by_staff_user_id)
          values ('BYR-202610-904', 'purchase', ${purchase!.id}, ${supplierA!.id}, 'Toko Kain A', '2026-10-06', 1000, 'cash', ${invoice!.id}, ${staff!.id})`,
      ).rejects.toThrow(/supplier_payments_payment_no_unique|supplier_payments_proof_file_fk/);

      // ---- Append-only: nothing about a payment can change, and it can never be deleted. ----
      for (const change of [
        () => client`update supplier_payments set amount = 1 where id = ${payment!.id}`,
        () => client`update supplier_payments set paid_at = '2026-10-07' where id = ${payment!.id}`,
        () => client`update supplier_payments set method = 'cash' where id = ${payment!.id}`,
        () => client`update supplier_payments set note = 'diubah' where id = ${payment!.id}`,
        () => client`update supplier_payments set supplier_name = 'Nama Lain' where id = ${payment!.id}`,
        () => client`update supplier_payments set proof_file_id = ${proof3!.id} where id = ${payment!.id}`,
        () => client`update supplier_payments set created_at = now() - interval '1 day' where id = ${payment!.id}`,
      ]) {
        await expect(change()).rejects.toThrow(/append-only/);
      }
      await expect(client`delete from supplier_payments where id = ${payment!.id}`).rejects.toThrow(/never deleted/);

      // The purchase can no longer change supplier or be deleted while a payment references it.
      await expect(client`update purchases set supplier_id = ${supplierB!.id} where id = ${purchase!.id}`).rejects.toThrow(
        /supplier_payments_purchase_supplier_fk/,
      );
      await expect(client`delete from purchases where id = ${purchase!.id}`).rejects.toThrow(/supplier_payments_purchase_supplier_fk/);
      await expect(client`delete from production_batches where id = ${postedBatch!.id}`).rejects.toThrow();

      // ---- Voiding: all three columns at once, a non-blank reason, exactly once. ----
      await expect(client`update supplier_payments set voided_at = now() where id = ${payment!.id}`).rejects.toThrow(
        /supplier_payments_voided_triple_check/,
      );
      await expect(
        client`update supplier_payments set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = '   ' where id = ${payment!.id}`,
      ).rejects.toThrow(/supplier_payments_voided_triple_check/);
      // Voiding together with any other change is refused.
      await expect(
        client`update supplier_payments set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Salah nominal', amount = 1
               where id = ${payment!.id}`,
      ).rejects.toThrow(/append-only/);
      const voided = await client`
        update supplier_payments set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Salah nominal'
        where id = ${payment!.id} and voided_at is null returning id`;
      expect(voided).toHaveLength(1);
      await expect(client`update supplier_payments set void_reason = 'Alasan lain' where id = ${payment!.id}`).rejects.toThrow(/already been voided/);
      await expect(
        client`update supplier_payments set voided_at = null, voided_by_staff_user_id = null, void_reason = null where id = ${payment!.id}`,
      ).rejects.toThrow(/already been voided/);
      // A second "void" through the app's conditional UPDATE matches nothing (and so never reaches the trigger).
      const again = await client`
        update supplier_payments set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Lagi'
        where id = ${payment!.id} and voided_at is null returning id`;
      expect(again).toHaveLength(0);
      await expect(client`delete from supplier_payments where id = ${payment!.id}`).rejects.toThrow(/never deleted/);

      // ---- purchase_attachments: a nota, same rules. ----
      const [attachment] = await client`
        insert into purchase_attachments (purchase_id, kind, file_id, created_by_staff_user_id)
        values (${otherPurchase!.id}, 'invoice', ${invoice!.id}, ${staff!.id}) returning id`;
      const [proof4] = await insertFile("payment_proof", "payment_proof/2026/10/4.jpg");
      await expect(
        client`insert into purchase_attachments (purchase_id, kind, file_id, created_by_staff_user_id)
               values (${otherPurchase!.id}, 'invoice', ${proof4!.id}, ${staff!.id})`,
      ).rejects.toThrow(/purchase_attachments_file_fk/);
      await expect(
        client`insert into purchase_attachments (purchase_id, kind, file_id, created_by_staff_user_id)
               values (${otherPurchase!.id}, 'receipt', ${invoice!.id}, ${staff!.id})`,
      ).rejects.toThrow(/purchase_attachments_kind_check|purchase_attachments_file_id_unique/);
      await expect(client`update purchase_attachments set note = 'x' where id = ${attachment!.id}`).rejects.toThrow(/append-only/);
      await expect(client`delete from purchase_attachments where id = ${attachment!.id}`).rejects.toThrow(/never deleted/);
      await client`
        update purchase_attachments set voided_at = now(), voided_by_staff_user_id = ${staff!.id}, void_reason = 'Nota salah'
        where id = ${attachment!.id}`;
      await expect(client`update purchase_attachments set void_reason = 'x' where id = ${attachment!.id}`).rejects.toThrow(/already been voided/);

      // ---- Re-running the migrator applies nothing and changes nothing. ----
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
      const [{ count: grantCount }] = (await client`
        select count(*)::int as count from role_permissions rp join permissions p on p.id = rp.permission_id
        join roles r on r.id = rp.role_id
        where p.key = 'supplier_payments.manage' and r.is_system`) as unknown as [{ count: number }];
      expect(grantCount).toBe(2);
    } finally {
      await client.end();
      rmSync(upTo0037, { recursive: true, force: true });
    }
  });
});
