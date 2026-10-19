import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0026 (docs/plans/suppliers-goods-receipt.md S5): the defect ledger. Applies on a fresh
// database, and on a database sitting at 0025 with purchase and production receipts already posted
// — leaving every existing receipt line at qty_rejected = 0 with its stock untouched, while the
// PREVIOUS release's own receipt writes keep working against the new schema (CLAUDE.md
// expand/contract: rollback redeploys the old image against this schema).
//
// Runs against two disposable databases of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASES = ["ammari_migration_0026_fresh", "ammari_migration_0026_upgrade"] as const;

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

/** A copy of the migrations folder whose journal stops at `lastIdx` — drizzle's migrator applies
 * exactly what the journal lists. */
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

/** Reference rows plus one purchase receipt (fabric line: 10 ordered, 8 accepted) and one
 * production receipt (batch line: 4 planned, 3 accepted), written the way the S3/S4 release writes
 * them — raw SQL, valid against the 0025 schema (and the 0026 one). */
async function seedReceipts(client: postgres.Sql) {
  const [role] = await client`
    insert into roles (key, name, is_system) values ('super_admin', 'super_admin', true)
    on conflict (key) do update set name = excluded.name returning id`;
  const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
  const [supplier] = await client`insert into suppliers (name) values ('Toko Kain') returning id`;
  const [fabric] = await client`insert into fabrics (name) values ('Katun') returning id`;
  const [accessory] = await client`insert into accessories (name) values ('Kancing') returning id`;
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
  const [accessoryLine] = await client`
    insert into purchase_items (purchase_id, item_type, accessory_id, qty_ordered, total_amount)
    values (${purchase!.id}, 'accessory', ${accessory!.id}, 6, 6000) returning id`;
  const [purchaseReceipt] = await client`
    insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
    values ('GR-202610-001', 'purchase', ${purchase!.id}, 'receipt', '2026-10-05', ${staff!.id}) returning id`;
  const [purchaseReceiptItem] = await client`
    insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted)
    values (${purchaseReceipt!.id}, 'purchase', 'receipt', ${fabricLine!.id}, 8) returning id`;
  await client`
    insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, ref_id, purchased_at, supplier_id, supplier, created_by_staff_user_id)
    values (${fabric!.id}, 8, 800000, 'purchase', 'goods_receipt', ${purchaseReceiptItem!.id}, '2026-10-05', ${supplier!.id}, 'Toko Kain', ${staff!.id})`;

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
    insert into goods_receipt_items (goods_receipt_id, source_type, kind, production_batch_item_id, qty_accepted)
    values (${batchReceipt!.id}, 'production_batch', 'receipt', ${batchLine!.id}, 3) returning id`;
  await client`
    insert into stock_movements (sku, qty, value_amount, type, ref_type, ref_id, created_by_staff_user_id)
    values (${variant!.sku}, 3, 360000, 'production', 'goods_receipt_item', ${batchReceiptItem!.id}, ${staff!.id})`;

  return {
    staffId: staff!.id as string,
    fabricId: fabric!.id as string,
    accessoryId: accessory!.id as string,
    sku: variant!.sku as string,
    purchaseId: purchase!.id as string,
    fabricLineId: fabricLine!.id as string,
    accessoryLineId: accessoryLine!.id as string,
    purchaseReceiptId: purchaseReceipt!.id as string,
    purchaseReceiptItemId: purchaseReceiptItem!.id as string,
    batchLineId: batchLine!.id as string,
    batchReceiptItemId: batchReceiptItem!.id as string,
  };
}

type Seeded = Awaited<ReturnType<typeof seedReceipts>>;

/** Every constraint and the trigger 0026 adds, exercised against real rows. */
async function assertDefectLedgerRules(client: postgres.Sql, s: Seeded) {
  // A fabric reject from a purchase receipt line, and a SKU reject from a batch receipt line.
  const [fabricReject] = await client`
    insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, goods_receipt_item_id, purchase_item_id, occurred_at, created_by_staff_user_id)
    values ('fabric', ${s.fabricId}, 'reject', 1.5, 150000, ${s.purchaseReceiptItemId}, ${s.fabricLineId}, '2026-10-05', ${s.staffId}) returning id`;
  await client`
    insert into defect_movements (item_kind, sku, type, qty, value_amount, goods_receipt_item_id, production_batch_item_id, occurred_at, created_by_staff_user_id)
    values ('sku', ${s.sku}, 'reject', 1, 120000, ${s.batchReceiptItemId}, ${s.batchLineId}, '2026-10-06', ${s.staffId})`;

  const insertRow = (overrides: Record<string, unknown>) => {
    const row = {
      item_kind: "fabric",
      fabric_id: s.fabricId,
      type: "reject",
      qty: 1,
      value_amount: 1,
      goods_receipt_item_id: s.purchaseReceiptItemId,
      purchase_item_id: s.fabricLineId,
      occurred_at: "2026-10-05",
      created_by_staff_user_id: s.staffId,
      ...overrides,
    };
    return client`insert into defect_movements ${client(row)}`;
  };
  const check = { code: "23514" };
  const fk = { code: "23503" };

  // One reject per receipt line.
  await expect(insertRow({})).rejects.toMatchObject({ code: "23505" });
  // Exactly one item, agreeing with item_kind; exactly one source line of the matching kind.
  await expect(insertRow({ accessory_id: s.accessoryId, goods_receipt_item_id: null, type: "return_out", qty: -1 })).rejects.toMatchObject(check);
  await expect(insertRow({ item_kind: "accessory", goods_receipt_item_id: null, type: "return_out", qty: -1 })).rejects.toMatchObject(check);
  await expect(insertRow({ production_batch_item_id: s.batchLineId, goods_receipt_item_id: null, type: "return_out", qty: -1 })).rejects.toMatchObject(check);
  await expect(insertRow({ purchase_item_id: null, goods_receipt_item_id: null, type: "return_out", qty: -1 })).rejects.toMatchObject(check);
  // The item must match its own source line (composite FKs): the fabric line is not an accessory line...
  await expect(
    insertRow({ item_kind: "accessory", fabric_id: null, accessory_id: s.accessoryId, goods_receipt_item_id: null, type: "return_out", qty: -1 }),
  ).rejects.toMatchObject(fk);
  // ...and a SKU must be the batch line's own SKU.
  const [otherVariant] = await client`
    insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
    select 'GMS01-HTM-L', product_id, fabric_id, fabric_color_id, closure, 'L' from product_variants where sku = ${s.sku} returning sku`;
  await expect(
    insertRow({ item_kind: "sku", fabric_id: null, sku: otherVariant!.sku, purchase_item_id: null, production_batch_item_id: s.batchLineId, goods_receipt_item_id: null, type: "return_out", qty: -1 }),
  ).rejects.toMatchObject(fk);
  // Signs: reject > 0, outflows < 0, never 0; whole pcs except fabric; a reject names its receipt line.
  await expect(insertRow({ qty: -1, goods_receipt_item_id: null })).rejects.toMatchObject(check);
  await expect(insertRow({ type: "return_out", qty: 1, goods_receipt_item_id: null })).rejects.toMatchObject(check);
  await expect(insertRow({ type: "return_out", qty: 0, goods_receipt_item_id: null })).rejects.toMatchObject(check);
  await expect(
    insertRow({ item_kind: "accessory", fabric_id: null, accessory_id: s.accessoryId, purchase_item_id: s.accessoryLineId, type: "return_out", qty: -1.5, goods_receipt_item_id: null }),
  ).rejects.toMatchObject(check);
  await expect(insertRow({ goods_receipt_item_id: null })).rejects.toMatchObject(check);
  await expect(insertRow({ type: "nonsense", goods_receipt_item_id: null })).rejects.toMatchObject(check);

  // Disposal (S6 writes these; the CHECKs ship now). All three types, D24 + D29.
  const dispose = (overrides: Record<string, unknown>) =>
    insertRow({ type: "dispose", qty: -0.5, value_amount: -50000, goods_receipt_item_id: null, note: "Dilepas", ...overrides });
  await dispose({ disposal_type: "auction", proceeds_amount: 20000 });
  await dispose({ disposal_type: "donation", proceeds_amount: 0 });
  await dispose({ disposal_type: "discarded", proceeds_amount: 0 });
  await expect(dispose({ disposal_type: "auction", proceeds_amount: 0 })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "donation", proceeds_amount: 1 })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "discarded", proceeds_amount: 1 })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "sold", proceeds_amount: 1 })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: null, proceeds_amount: null })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "donation", proceeds_amount: null })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "discarded", proceeds_amount: 0, note: "  " })).rejects.toMatchObject(check);
  await expect(dispose({ disposal_type: "discarded", proceeds_amount: 0, note: null })).rejects.toMatchObject(check);
  // disposal_type only on a dispose row or its reversal.
  await expect(insertRow({ type: "return_out", qty: -1, goods_receipt_item_id: null, disposal_type: "donation", proceeds_amount: 0 })).rejects.toMatchObject(check);

  // Reversal: needs reverses_movement_id (and only a reversal has one), at most one per row.
  await expect(insertRow({ type: "reversal", qty: -1.5, value_amount: -150000 })).rejects.toMatchObject(check);
  await expect(insertRow({ type: "return_out", qty: -1, goods_receipt_item_id: null, reverses_movement_id: fabricReject!.id })).rejects.toMatchObject(check);
  const [reversal] = await client`
    insert into defect_movements (item_kind, fabric_id, type, qty, value_amount, goods_receipt_item_id, purchase_item_id, occurred_at, reverses_movement_id, created_by_staff_user_id)
    values ('fabric', ${s.fabricId}, 'reversal', -1.5, -150000, ${s.purchaseReceiptItemId}, ${s.fabricLineId}, '2026-10-07', ${fabricReject!.id}, ${s.staffId}) returning id`;
  await expect(
    insertRow({ type: "reversal", qty: -1.5, value_amount: -150000, reverses_movement_id: fabricReject!.id }),
  ).rejects.toMatchObject({ code: "23505" });

  // Immutability trigger: no delete, no edit; the reversal stamp exactly once.
  await expect(client`delete from defect_movements where id = ${fabricReject!.id}`).rejects.toMatchObject(check);
  await expect(client`update defect_movements set qty = 2 where id = ${fabricReject!.id}`).rejects.toMatchObject(check);
  await expect(client`update defect_movements set reversed_at = now() where id = ${fabricReject!.id}`).rejects.toMatchObject(check); // pair check
  await client`update defect_movements set reversed_at = now(), reversed_by_staff_user_id = ${s.staffId} where id = ${fabricReject!.id}`;
  await expect(client`update defect_movements set reversed_at = now(), reversed_by_staff_user_id = ${s.staffId} where id = ${fabricReject!.id}`).rejects.toMatchObject(check);
  // A reversal itself can never be marked reversed.
  await expect(client`update defect_movements set reversed_at = now(), reversed_by_staff_user_id = ${s.staffId} where id = ${reversal!.id}`).rejects.toMatchObject(check);
  // RESTRICT: a referenced receipt line cannot disappear from under its defect row.
  await expect(client`delete from goods_receipt_items where id = ${s.batchReceiptItemId}`).rejects.toMatchObject(fk);
}

describe("migration 0026", () => {
  test("applies cleanly to a fresh database: defect ledger, its trigger and qty_rejected exist and enforce the plan's rules", async () => {
    await recreateDatabase("ammari_migration_0026_fresh");
    const client = postgres(urlFor("ammari_migration_0026_fresh"), { max: 1, onnotice: () => {} });
    try {
      await migrateTo(client, migrationsFolder);
      const [column] = await client<{ column_default: string | null; is_nullable: string; data_type: string }[]>`
        select column_default, is_nullable, data_type from information_schema.columns
        where table_name = 'goods_receipt_items' and column_name = 'qty_rejected'`;
      expect(column).toMatchObject({ is_nullable: "NO", data_type: "numeric" });
      expect(column?.column_default).toBe("0");
      const triggers = await client`select tgname from pg_trigger where tgrelid = 'defect_movements'::regclass and not tgisinternal`;
      expect(triggers.map((row) => row.tgname)).toEqual(["prevent_defect_movement_mutation"]);

      const seeded = await seedReceipts(client);
      await assertDefectLedgerRules(client, seeded);
    } finally {
      await client.end();
    }
  });

  test("upgrades a database at 0025 with posted receipts: lines read as nothing rejected, stock untouched, previous release keeps working", async () => {
    await recreateDatabase("ammari_migration_0026_upgrade");
    const client = postgres(urlFor("ammari_migration_0026_upgrade"), { max: 1, onnotice: () => {} });
    const at0025 = migrationsUpTo(25);
    try {
      await migrateTo(client, at0025);
      const seeded = await seedReceipts(client);
      const ledgersBefore = await client`
        select (select sum(qty)::text from fabric_stock_movements) as fabric, (select sum(qty)::int from stock_movements) as sku`;

      // ---- Upgrade to head. ----
      await migrateTo(client, migrationsFolder);

      const items = await client<{ qty_accepted: string; qty_rejected: string }[]>`
        select qty_accepted::text, qty_rejected::text from goods_receipt_items order by qty_accepted`;
      expect(items).toEqual([
        { qty_accepted: "3.00", qty_rejected: "0.00" },
        { qty_accepted: "8.00", qty_rejected: "0.00" },
      ]);
      expect(await client`
        select (select sum(qty)::text from fabric_stock_movements) as fabric, (select sum(qty)::int from stock_movements) as sku`).toEqual(ledgersBefore);
      expect(await client`select count(*)::int as n from defect_movements`).toEqual([{ n: 0 }]);

      // The PREVIOUS release keeps working: its receipt insert never names qty_rejected.
      const [receipt] = await client`
        insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
        values ('GR-202610-003', 'purchase', ${seeded.purchaseId}, 'receipt', '2026-10-08', ${seeded.staffId}) returning id`;
      await client`
        insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted)
        values (${receipt!.id}, 'purchase', 'receipt', ${seeded.fabricLineId}, 2)`;
      // ...and a line that does nothing is still refused (the widened nonzero check).
      await expect(
        client`
          insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted)
          values (${receipt!.id}, 'purchase', 'receipt', ${seeded.accessoryLineId}, 0)`,
      ).rejects.toMatchObject({ code: "23514" });
      // New: a line may accept 0 and reject some; signs and whole pcs are enforced on qty_rejected.
      await client`
        insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted, qty_rejected)
        values (${receipt!.id}, 'purchase', 'receipt', ${seeded.accessoryLineId}, 0, 2)`;
      await expect(
        client`
          insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted, qty_rejected)
          values (${seeded.purchaseReceiptId}, 'purchase', 'receipt', ${seeded.accessoryLineId}, 1, -1)`,
      ).rejects.toMatchObject({ code: "23514" });

      await assertDefectLedgerRules(client, seeded);
    } finally {
      await client.end();
      rmSync(at0025, { recursive: true, force: true });
    }
  });
});
