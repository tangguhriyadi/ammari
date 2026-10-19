import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0027 (docs/plans/suppliers-goods-receipt.md S6): re-open columns on purchases and
// production_batches, the reject receipt-item ⇔ source-line composite FKs, and the trigger that
// makes a defect reversal the exact negation of the row it reverses. Applies on a fresh database,
// and on a database sitting at 0026 with rejects (and a reject reversal) already posted — leaving
// every row as it was, while the PREVIOUS release's own writes keep working against the new
// schema (CLAUDE.md expand/contract).
//
// Runs against two disposable databases of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASES = ["ammari_migration_0027_fresh", "ammari_migration_0027_upgrade"] as const;

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

async function recreateDatabase(database: (typeof SCRATCH_DATABASES)[number]): Promise<void> {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
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

async function migrateTo(client: postgres.Sql, folder: string): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder: folder });
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    for (const database of SCRATCH_DATABASES) await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  } finally {
    await admin.end();
  }
});

/** A purchase (fabric line: 10 ordered; receipt of 8 good + 2 rejected; a second fabric line on
 * another purchase), a batch (line: 4 planned; receipt of 3 good + 1 rejected) and one reject
 * reversal — written the way the S5 release writes them, valid against 0026 and 0027. */
async function seed(client: postgres.Sql) {
  const [role] = await client`
    insert into roles (key, name, is_system) values ('super_admin', 'super_admin', true)
    on conflict (key) do update set name = excluded.name returning id`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
  const [supplier] = await client`insert into suppliers (name) values ('Toko Kain') returning id`;
  const [fabric] = await client`insert into fabrics (name) values ('Katun') returning id`;
  const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Hitam') returning id`;
  const [product] = await client`
    insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
    values ('Gamis', 'GMS01', 'gamis', ${fabric!.id}, 'front_zip', 'sized', 259000) returning id`;
  const [variant] = await client`
    insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
    values ('GMS01-HTM-M', ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', 'M') returning sku`;

  const [purchase] = await client`
    insert into purchases (purchase_no, supplier_id, ordered_at, status, created_by_staff_user_id)
    values ('PO-202610-001', ${supplier!.id}, '2026-10-01', 'partially_received', ${staff!.id}) returning id`;
  const [fabricLine] = await client`
    insert into purchase_items (purchase_id, item_type, fabric_id, qty_ordered, total_amount)
    values (${purchase!.id}, 'fabric', ${fabric!.id}, 10, 1000000) returning id`;
  const [otherPurchase] = await client`
    insert into purchases (purchase_no, supplier_id, ordered_at, status, created_by_staff_user_id)
    values ('PO-202610-002', ${supplier!.id}, '2026-10-01', 'ordered', ${staff!.id}) returning id`;
  const [otherFabricLine] = await client`
    insert into purchase_items (purchase_id, item_type, fabric_id, qty_ordered, total_amount)
    values (${otherPurchase!.id}, 'fabric', ${fabric!.id}, 5, 500000) returning id`;
  const [receipt] = await client`
    insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
    values ('GR-202610-001', 'purchase', ${purchase!.id}, 'receipt', '2026-10-05', ${staff!.id}) returning id`;
  const [receiptItem] = await client`
    insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted, qty_rejected)
    values (${receipt!.id}, 'purchase', 'receipt', ${fabricLine!.id}, 8, 2) returning id`;
  const [fabricReject] = await client`
    insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, goods_receipt_item_id, purchase_item_id, occurred_at, created_by_staff_user_id)
    values ('fabric', ${fabric!.id}, 'reject', 2, 200000, ${receiptItem!.id}, ${fabricLine!.id}, '2026-10-05', ${staff!.id}) returning id`;

  const [batch] = await client`
    insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards)
    values (${fabric!.id}, 'PRD-202610-001', '2026-10-02', 5) returning id`;
  const [batchLine] = await client`
    insert into production_batch_items (production_batch_id, fabric_id, sku, qty, unit_cost_amount)
    values (${batch!.id}, ${fabric!.id}, ${variant!.sku}, 4, 0) returning id`;
  await client`update production_batch_items set unit_cost_amount = 120000 where id = ${batchLine!.id}`;
  await client`
    update production_batches set status = 'posted', posted_at = now(), posted_by_staff_user_id = ${staff!.id},
      fabric_cost_amount = 480000, receipt_status = 'partially_received' where id = ${batch!.id}`;
  const [batchReceipt] = await client`
    insert into goods_receipts (receipt_no, source_type, production_batch_id, kind, received_at, created_by_staff_user_id)
    values ('GR-202610-002', 'production_batch', ${batch!.id}, 'receipt', '2026-10-06', ${staff!.id}) returning id`;
  const [batchReceiptItem] = await client`
    insert into goods_receipt_items (goods_receipt_id, source_type, kind, production_batch_item_id, qty_accepted, qty_rejected)
    values (${batchReceipt!.id}, 'production_batch', 'receipt', ${batchLine!.id}, 3, 1) returning id`;
  const [skuReject] = await client`
    insert into defect_movements (item_kind, sku, type, qty, value_amount, goods_receipt_item_id, production_batch_item_id, occurred_at, created_by_staff_user_id)
    values ('sku', ${variant!.sku}, 'reject', 1, 120000, ${batchReceiptItem!.id}, ${batchLine!.id}, '2026-10-06', ${staff!.id}) returning id`;

  return {
    staffId: staff!.id as string,
    fabricId: fabric!.id as string,
    sku: variant!.sku as string,
    purchaseId: purchase!.id as string,
    batchId: batch!.id as string,
    fabricLineId: fabricLine!.id as string,
    otherFabricLineId: otherFabricLine!.id as string,
    receiptItemId: receiptItem!.id as string,
    batchLineId: batchLine!.id as string,
    batchReceiptItemId: batchReceiptItem!.id as string,
    fabricRejectId: fabricReject!.id as string,
    skuRejectId: skuReject!.id as string,
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;
const check = { code: "23514" };
const fk = { code: "23503" };

/** Everything 0027 adds, exercised against real rows. */
async function assertRules(client: postgres.Sql, s: Seeded) {
  // ---- Re-open columns: all three or none, reason never blank. ----
  for (const table of ["purchases", "production_batches"] as const) {
    const id = table === "purchases" ? s.purchaseId : s.batchId;
    await expect(client`update ${client(table)} set reopened_at = now() where id = ${id}`).rejects.toMatchObject(check);
    await expect(
      client`update ${client(table)} set reopened_at = now(), reopened_by_staff_user_id = ${s.staffId}, reopen_reason = '  ' where id = ${id}`,
    ).rejects.toMatchObject(check);
    await client`update ${client(table)} set reopened_at = now(), reopened_by_staff_user_id = ${s.staffId}, reopen_reason = 'Barang cacat dikembalikan' where id = ${id}`;
  }

  // ---- A reject's receipt item must belong to the reject's own source line. ----
  // A fresh receipt item on the first fabric line (no reject yet, so 0026's one-reject-per-item
  // unique index is not what fires).
  const [freshReceipt] = await client`
    insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
    values ('GR-202610-099', 'purchase', ${s.purchaseId}, 'receipt', '2026-10-07', ${s.staffId}) returning id`;
  const [freshItem] = await client`
    insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted, qty_rejected)
    values (${freshReceipt!.id}, 'purchase', 'receipt', ${s.fabricLineId}, 0, 1) returning id`;
  // A reject naming ANOTHER line than its receipt item's is refused...
  await expect(
    client`
      insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, goods_receipt_item_id, purchase_item_id, occurred_at, created_by_staff_user_id)
      values ('fabric', ${s.fabricId}, 'reject', 1, 100000, ${freshItem!.id}, ${s.otherFabricLineId}, '2026-10-07', ${s.staffId})`,
  ).rejects.toMatchObject(fk);
  // ...and so is a SKU reject naming a purchase receipt item (the batch-line FK).
  await expect(
    client`
      insert into defect_movements (item_kind, sku, type, qty, value_amount, goods_receipt_item_id, production_batch_item_id, occurred_at, created_by_staff_user_id)
      values ('sku', ${s.sku}, 'reject', 1, 120000, ${freshItem!.id}, ${s.batchLineId}, '2026-10-07', ${s.staffId})`,
  ).rejects.toMatchObject(fk);

  // ---- A reversal must exactly negate the row it reverses. ----
  const reverseFabric = (overrides: Record<string, unknown>) =>
    client`insert into defect_movements ${client({
      item_kind: "fabric",
      fabric_id: s.fabricId,
      type: "reversal",
      qty: -2,
      value_amount: -200000,
      goods_receipt_item_id: s.receiptItemId,
      purchase_item_id: s.fabricLineId,
      occurred_at: "2026-10-07",
      reverses_movement_id: s.fabricRejectId,
      created_by_staff_user_id: s.staffId,
      ...overrides,
    })} returning id`;
  await expect(reverseFabric({ qty: -1 })).rejects.toMatchObject(check);
  await expect(reverseFabric({ value_amount: -199999 })).rejects.toMatchObject(check);
  await expect(reverseFabric({ disposal_type: "donation", proceeds_amount: 0 })).rejects.toMatchObject(check);

  // A release and its reversal: proceeds and disposal_type must be carried, negated.
  const [release] = await client`
    insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, purchase_item_id, disposal_type, proceeds_amount, occurred_at, note, created_by_staff_user_id)
    values ('fabric', ${s.fabricId}, 'dispose', -1, -100000, ${s.fabricLineId}, 'auction', 30000, '2026-10-07', 'Lelang', ${s.staffId}) returning id`;
  const reverseRelease = (overrides: Record<string, unknown>) =>
    client`insert into defect_movements ${client({
      item_kind: "fabric",
      fabric_id: s.fabricId,
      type: "reversal",
      qty: 1,
      value_amount: 100000,
      purchase_item_id: s.fabricLineId,
      disposal_type: "auction",
      proceeds_amount: -30000,
      occurred_at: "2026-10-08",
      reverses_movement_id: release!.id,
      created_by_staff_user_id: s.staffId,
      ...overrides,
    })} returning id`;
  await expect(reverseRelease({ disposal_type: null, proceeds_amount: null })).rejects.toMatchObject(check);
  await expect(reverseRelease({ proceeds_amount: 30000 })).rejects.toMatchObject(check);
  await expect(reverseRelease({ disposal_type: "donation" })).rejects.toMatchObject(check);
  await expect(reverseRelease({ purchase_item_id: s.otherFabricLineId })).rejects.toMatchObject(check);
  const [releaseReversal] = await reverseRelease({});
  // A reversal can never be reversed.
  await expect(
    client`
      insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, purchase_item_id, disposal_type, proceeds_amount, occurred_at, reverses_movement_id, created_by_staff_user_id)
      values ('fabric', ${s.fabricId}, 'reversal', -1, -100000, ${s.fabricLineId}, 'auction', 30000, '2026-10-09', ${releaseReversal!.id}, ${s.staffId})`,
  ).rejects.toMatchObject(check);

  // The exact copy-and-negate reversal of the reject (what reverseRejectsInTx writes) passes.
  await reverseFabric({});
}

describe("migration 0027", () => {
  test("applies cleanly to a fresh database: re-open columns, reject/source-line FKs and the reversal trigger enforce the plan's rules", async () => {
    await recreateDatabase("ammari_migration_0027_fresh");
    const client = postgres(urlFor("ammari_migration_0027_fresh"), { max: 1, onnotice: () => {} });
    try {
      await migrateTo(client, migrationsFolder);
      const columns = await client<{ table_name: string; column_name: string; is_nullable: string }[]>`
        select table_name, column_name, is_nullable from information_schema.columns
        where column_name in ('reopened_at', 'reopened_by_staff_user_id', 'reopen_reason') order by table_name, column_name`;
      expect(columns).toHaveLength(6);
      expect(columns.every((column) => column.is_nullable === "YES")).toBe(true);
      const triggers = await client`select tgname from pg_trigger where tgrelid = 'defect_movements'::regclass and not tgisinternal order by tgname`;
      expect(triggers.map((row) => row.tgname)).toEqual(["check_defect_reversal_matches", "prevent_defect_movement_mutation"]);

      await assertRules(client, await seed(client));
    } finally {
      await client.end();
    }
  });

  test("upgrades a database at 0026 with rejects and a reject reversal: every row unchanged, previous release keeps working", async () => {
    await recreateDatabase("ammari_migration_0027_upgrade");
    const client = postgres(urlFor("ammari_migration_0027_upgrade"), { max: 1, onnotice: () => {} });
    const at0026 = migrationsUpTo(26);
    try {
      await migrateTo(client, at0026);
      const seeded = await seed(client);
      // A reject reversal on the batch line, written the S5 way (pointing at a reversal receipt's item).
      const [reversalReceipt] = await client`
        insert into goods_receipts (receipt_no, source_type, production_batch_id, kind, received_at, reverses_receipt_id, created_by_staff_user_id)
        select 'GR-202610-003', 'production_batch', ${seeded.batchId}, 'reversal', '2026-10-07', gr.id, ${seeded.staffId}
        from goods_receipts gr where gr.receipt_no = 'GR-202610-002' returning id`;
      const [reversalItem] = await client`
        insert into goods_receipt_items (goods_receipt_id, source_type, kind, production_batch_item_id, qty_accepted, qty_rejected)
        values (${reversalReceipt!.id}, 'production_batch', 'reversal', ${seeded.batchLineId}, -3, -1) returning id`;
      await client`
        insert into defect_movements (item_kind, sku, type, qty, value_amount, goods_receipt_item_id, production_batch_item_id, occurred_at, reverses_movement_id, created_by_staff_user_id)
        values ('sku', ${seeded.sku}, 'reversal', -1, -120000, ${reversalItem!.id}, ${seeded.batchLineId}, '2026-10-07', ${seeded.skuRejectId}, ${seeded.staffId})`;
      const snapshot = () => client`
        select id, type, qty::text, value_amount::text, goods_receipt_item_id from defect_movements order by created_at, id`;
      const before = await snapshot();

      // ---- Upgrade to head. ----
      await migrateTo(client, migrationsFolder);
      expect(await snapshot()).toEqual(before);
      expect(await client`select count(*)::int as n from purchases where reopened_at is not null`).toEqual([{ n: 0 }]);

      // The PREVIOUS release keeps working: closing a document never names the re-open columns...
      await client`update purchases set status = 'closed', closed_at = now(), closed_by_staff_user_id = ${seeded.staffId}, close_reason = 'Cukup' where id = ${seeded.purchaseId}`;
      await client`update production_batches set receipt_status = 'closed', closed_at = now(), closed_by_staff_user_id = ${seeded.staffId}, close_reason = 'Cukup' where id = ${seeded.batchId}`;
      // ...and its reject writes still pass both new FKs.
      const [receipt] = await client`
        insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
        values ('GR-202610-004', 'purchase', (select purchase_id from purchase_items where id = ${seeded.otherFabricLineId}), 'receipt', '2026-10-08', ${seeded.staffId}) returning id`;
      const [item] = await client`
        insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted, qty_rejected)
        values (${receipt!.id}, 'purchase', 'receipt', ${seeded.otherFabricLineId}, 4, 1) returning id`;
      await client`
        insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, goods_receipt_item_id, purchase_item_id, occurred_at, created_by_staff_user_id)
        values ('fabric', ${seeded.fabricId}, 'reject', 1, 100000, ${item!.id}, ${seeded.otherFabricLineId}, '2026-10-08', ${seeded.staffId})`;

      await assertRules(client, seeded);
    } finally {
      await client.end();
      rmSync(at0026, { recursive: true, force: true });
    }
  });
});
