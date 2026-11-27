import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { migrationsFolder, migrationsUpTo } from "./scratch-database";

// Migration 0046 (fabric stock per colour, docs/plans/fabric-colour-stock.md §3, session S1):
// purchase_items.fabric_color_id, fabric_stock_movements.fabric_color_id and the new
// production_batch_fabric_usages table. Upgrades a database sitting at 0045 that holds the
// prod-like shape (colourless purchase lines, a received line, legacy + receipt + production
// ledger rows, a posted and a draft batch, a fabric without colours), then checks that every
// existing row stays valid as "Tanpa warna", per-fabric totals are unchanged, the previous
// release's writes keep working, every new constraint/trigger, and that re-running is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_migration_0046_upgrade";

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

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

describe("migration 0046 (fabric stock per colour)", () => {
  test("upgrades a database at 0045, keeps colourless rows valid as Tanpa warna, and enforces the colour constraints", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0045 = migrationsUpTo(45);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0045 });

      // ---- State at 0045, as the previous release leaves it. ----
      const [role] = await client`
        insert into roles (key, name, is_system) values ('super_admin', 'super_admin', true)
        on conflict (key) do update set name = excluded.name returning id`;
      const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
      const [supplier] = await client`insert into suppliers (name) values ('JMS Textile') returning id`;
      const [marbella] = await client`insert into fabrics (name) values ('Marbella Anti UV') returning id`;
      const [sage] = await client`insert into fabric_colors (fabric_id, name) values (${marbella!.id}, 'Sage') returning id`;
      const [mocca] = await client`insert into fabric_colors (fabric_id, name) values (${marbella!.id}, 'Mocca') returning id`;
      // A fabric without colours at all (2 of 4 on the dev DB are like this).
      const [plain] = await client`insert into fabrics (name) values ('Katun Polos') returning id`;
      const [other] = await client`insert into fabrics (name) values ('Wolfis') returning id`;
      const [otherColor] = await client`insert into fabric_colors (fabric_id, name) values (${other!.id}, 'Hitam') returning id`;
      const [accessory] = await client`insert into accessories (name) values ('Hang tag') returning id`;

      // A received purchase (colourless fabric line + accessory line) and an open one.
      const [receivedPo] = await client`
        insert into purchases (purchase_no, supplier_id, ordered_at, status, created_by_staff_user_id)
        values ('PO-202611-001', ${supplier!.id}, '2026-11-01', 'received', ${staff!.id}) returning id`;
      const [receivedLine] = await client`
        insert into purchase_items (purchase_id, item_type, fabric_id, qty_ordered, total_amount)
        values (${receivedPo!.id}, 'fabric', ${marbella!.id}, 100, 1950000) returning id`;
      await client`
        insert into purchase_items (purchase_id, item_type, accessory_id, qty_ordered, total_amount)
        values (${receivedPo!.id}, 'accessory', ${accessory!.id}, 50, 50000)`;
      const [receipt] = await client`
        insert into goods_receipts (receipt_no, source_type, purchase_id, kind, received_at, created_by_staff_user_id)
        values ('GR-202611-001', 'purchase', ${receivedPo!.id}, 'receipt', '2026-11-02', ${staff!.id}) returning id`;
      const [receiptItem] = await client`
        insert into goods_receipt_items (goods_receipt_id, source_type, kind, purchase_item_id, qty_accepted)
        values (${receipt!.id}, 'purchase', 'receipt', ${receivedLine!.id}, 100) returning id`;
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, ref_id, purchased_at, supplier_id, created_by_staff_user_id)
        values (${marbella!.id}, 100, 1950000, 'purchase', 'goods_receipt', ${receiptItem!.id}, '2026-11-02', ${supplier!.id}, ${staff!.id})`;
      const [openPo] = await client`
        insert into purchases (purchase_no, supplier_id, ordered_at, created_by_staff_user_id)
        values ('PO-202611-002', ${supplier!.id}, '2026-11-03', ${staff!.id}) returning id`;
      const [openLine] = await client`
        insert into purchase_items (purchase_id, item_type, fabric_id, qty_ordered, total_amount)
        values (${openPo!.id}, 'fabric', ${marbella!.id}, 838, 16341000) returning id`;

      // Legacy manual purchase on the colourless fabric, and a posted batch's consumption.
      const [legacyPurchase] = await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, purchased_at, created_by_staff_user_id)
        values (${plain!.id}, 20.5, 410000, 'purchase', 'manual', '2026-10-01', ${staff!.id}) returning id`;
      const [postedBatch] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards, fabric_cost_amount, status, posted_at, posted_by_staff_user_id)
        values (${marbella!.id}, 'B-202611-001', '2026-11-04', 30, 585000, 'posted', now(), ${staff!.id}) returning id`;
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, ref_id, created_by_staff_user_id)
        values (${marbella!.id}, -30, -585000, 'production', 'production_batch', ${postedBatch!.id}, ${staff!.id})`;
      const [draftBatch] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards) values (${marbella!.id}, 'B-202611-002', '2026-11-05', 12) returning id`;

      const totalsSql = () => client`
        select fabric_id, sum(qty)::text as qty, sum(value_amount)::text as value
        from fabric_stock_movements group by fabric_id order by fabric_id`;
      const totalsBefore = await totalsSql();

      await migrate(drizzle(client), { migrationsFolder });

      // ---- Every existing row is valid and reads as "Tanpa warna"; totals unchanged. ----
      const [{ coloredLines }] = (await client`
        select count(*)::int as "coloredLines" from purchase_items where fabric_color_id is not null`) as unknown as [{ coloredLines: number }];
      expect(coloredLines).toBe(0);
      const [{ coloredMovements }] = (await client`
        select count(*)::int as "coloredMovements" from fabric_stock_movements where fabric_color_id is not null`) as unknown as [
        { coloredMovements: number },
      ];
      expect(coloredMovements).toBe(0);
      expect(await totalsSql()).toEqual(totalsBefore);
      // The Tanpa warna bucket of each fabric is exactly its previous total.
      const tanpaWarna = await client`
        select fabric_id, sum(qty)::text as qty, sum(value_amount)::text as value
        from fabric_stock_movements where fabric_color_id is null group by fabric_id order by fabric_id`;
      expect(tanpaWarna).toEqual(totalsBefore);
      // Every existing constraint is still satisfied: re-validating is a no-op.
      const [{ invalid }] = (await client`
        select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
      expect(invalid).toBe(0);
      const [{ usageCount }] = (await client`select count(*)::int as "usageCount" from production_batch_fabric_usages`) as unknown as [
        { usageCount: number },
      ];
      expect(usageCount).toBe(0);

      // ---- The previous release's writes keep working (it never names the new columns). ----
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, reason, created_by_staff_user_id)
        values (${marbella!.id}, -1.25, -24375, 'adjustment', 'manual', 'damaged', ${staff!.id})`;
      await client`update purchase_items set qty_ordered = 840, total_amount = 16380000 where id = ${openLine!.id}`;
      // Its line-set replace (delete + reinsert) on an unreceived purchase.
      await client`delete from purchase_items where purchase_id = ${openPo!.id}`;
      const [reinserted] = await client`
        insert into purchase_items (purchase_id, item_type, fabric_id, qty_ordered, total_amount)
        values (${openPo!.id}, 'fabric', ${marbella!.id}, 838, 16341000) returning id`;
      // Its legacy void of a manual purchase (only the void columns change).
      await client`update fabric_stock_movements set voided_at = now(), voided_by_staff_user_id = ${staff!.id} where id = ${legacyPurchase!.id}`;
      // Its draft-batch edit and delete (usage rows, if any, cascade).
      await client`update production_batches set fabric_yards = 14 where id = ${draftBatch!.id}`;

      // ---- purchase_items: one line per colour. ----
      const insertLine = (purchaseId: string, fabricId: string | null, colorId: string | null, itemType = "fabric", accessoryId: string | null = null) =>
        client`
          insert into purchase_items (purchase_id, item_type, fabric_id, fabric_color_id, accessory_id, qty_ordered, total_amount)
          values (${purchaseId}, ${itemType}, ${fabricId}, ${colorId}, ${accessoryId}, 10, 195000) returning id`;
      const [newPo] = await client`
        insert into purchases (purchase_no, supplier_id, ordered_at, created_by_staff_user_id)
        values ('PO-202611-003', ${supplier!.id}, '2026-11-06', ${staff!.id}) returning id`;
      const [sageLine] = await insertLine(newPo!.id, marbella!.id, sage!.id);
      await insertLine(newPo!.id, marbella!.id, mocca!.id);
      await expect(insertLine(newPo!.id, marbella!.id, sage!.id)).rejects.toThrow(/purchase_items_purchase_id_fabric_color_id_key/);
      // One colourless line per fabric per purchase, still (the replaced 0024 rule).
      await expect(insertLine(openPo!.id, marbella!.id, null)).rejects.toThrow(/purchase_items_purchase_id_fabric_id_no_color_key/);
      await insertLine(newPo!.id, plain!.id, null);
      // A colour of ANOTHER fabric is refused by the composite FK.
      await expect(insertLine(newPo!.id, marbella!.id, otherColor!.id)).rejects.toThrow(/purchase_items_fabric_color_fabric_fk/);
      // An accessory line can never carry a colour (MATCH SIMPLE would skip the FK).
      await expect(insertLine(newPo!.id, null, sage!.id, "accessory", accessory!.id)).rejects.toThrow(
        /purchase_items_fabric_color_fabric_only_check/,
      );
      // Accessory lines don't collide with each other through the colour indexes, and the
      // accessory dedup is untouched.
      await insertLine(newPo!.id, null, null, "accessory", accessory!.id);
      await expect(insertLine(newPo!.id, null, null, "accessory", accessory!.id)).rejects.toThrow(
        /purchase_items_purchase_id_accessory_id_key/,
      );
      // An unreceived line's colour can be changed; a received line's colour is frozen.
      await client`update purchase_items set fabric_color_id = ${mocca!.id} where id = ${reinserted!.id}`;
      await expect(client`update purchase_items set fabric_color_id = ${sage!.id} where id = ${receivedLine!.id}`).rejects.toThrow(
        /purchase line that already has a receipt/,
      );
      // A colour used on a purchase line can no longer be hard-deleted (deactivate instead).
      await expect(client`delete from fabric_colors where id = ${sage!.id}`).rejects.toThrow(/purchase_items_fabric_color_fabric_fk/);
      expect(sageLine).toBeDefined();

      // ---- fabric_stock_movements: colour bucket, same fabric only, immutable. ----
      const [sageMovement] = await client`
        insert into fabric_stock_movements (fabric_id, fabric_color_id, qty, value_amount, type, ref_type, reason, created_by_staff_user_id)
        values (${marbella!.id}, ${sage!.id}, 5, 97500, 'adjustment', 'manual', 'recount', ${staff!.id}) returning id`;
      await expect(
        client`
          insert into fabric_stock_movements (fabric_id, fabric_color_id, qty, value_amount, type, ref_type, reason, created_by_staff_user_id)
          values (${marbella!.id}, ${otherColor!.id}, 5, 97500, 'adjustment', 'manual', 'recount', ${staff!.id})`,
      ).rejects.toThrow(/fabric_stock_movements_fabric_color_fabric_fk/);
      await expect(client`update fabric_stock_movements set fabric_color_id = ${mocca!.id} where id = ${sageMovement!.id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(client`update fabric_stock_movements set fabric_color_id = null where id = ${sageMovement!.id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(client`delete from fabric_stock_movements where id = ${sageMovement!.id}`).rejects.toThrow(/append-only/);

      // ---- production_batch_fabric_usages: per-bucket rows, frozen once posted. ----
      const insertUsage = (batchId: string, fabricId: string, colorId: string | null, yards: number) =>
        client`
          insert into production_batch_fabric_usages (production_batch_id, fabric_id, fabric_color_id, yards)
          values (${batchId}, ${fabricId}, ${colorId}, ${yards}) returning id`;
      const [usageSage] = await insertUsage(draftBatch!.id, marbella!.id, sage!.id, 8.5);
      await insertUsage(draftBatch!.id, marbella!.id, null, 5.5);
      await expect(insertUsage(draftBatch!.id, marbella!.id, sage!.id, 1)).rejects.toThrow(/production_batch_fabric_usages_batch_color_key/);
      // NULLS NOT DISTINCT: one Tanpa warna row per batch.
      await expect(insertUsage(draftBatch!.id, marbella!.id, null, 1)).rejects.toThrow(/production_batch_fabric_usages_batch_color_key/);
      await expect(insertUsage(draftBatch!.id, marbella!.id, otherColor!.id, 1)).rejects.toThrow(
        /production_batch_fabric_usages_fabric_color_fabric_fk/,
      );
      // The usage's fabric must be the batch's own fabric.
      await expect(insertUsage(draftBatch!.id, other!.id, otherColor!.id, 1)).rejects.toThrow(/production_batch_fabric_usages_batch_fabric_fk/);
      await expect(insertUsage(draftBatch!.id, marbella!.id, mocca!.id, 0)).rejects.toThrow(/production_batch_fabric_usages_yards_check/);
      // A draft's rows are freely editable.
      await client`update production_batch_fabric_usages set yards = 8.75 where id = ${usageSage!.id}`;

      // A posted batch's usage is frozen: no insert, no update, no delete, no moving rows across.
      await expect(insertUsage(postedBatch!.id, marbella!.id, sage!.id, 1)).rejects.toThrow(/posted production batch/);
      const [secondDraft] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards) values (${marbella!.id}, 'B-202611-003', '2026-11-07', 3) returning id`;
      const [frozenUsage] = await insertUsage(secondDraft!.id, marbella!.id, mocca!.id, 3);
      await client`
        update production_batches set status = 'posted', posted_at = now(), posted_by_staff_user_id = ${staff!.id} where id = ${secondDraft!.id}`;
      await expect(client`update production_batch_fabric_usages set yards = 4 where id = ${frozenUsage!.id}`).rejects.toThrow(
        /posted production batch/,
      );
      await expect(client`delete from production_batch_fabric_usages where id = ${frozenUsage!.id}`).rejects.toThrow(/posted production batch/);
      await expect(
        client`update production_batch_fabric_usages set production_batch_id = ${draftBatch!.id} where id = ${frozenUsage!.id}`,
      ).rejects.toThrow(/posted production batch/);
      // A colour used by a batch's usage can't be hard-deleted.
      await expect(client`delete from fabric_colors where id = ${mocca!.id}`).rejects.toThrow(/fabric_color_fabric_fk/);

      // Deleting a draft (the previous release's deleteDraft) cascades its usage rows.
      await client`delete from production_batches where id = ${draftBatch!.id}`;
      const [{ leftover }] = (await client`
        select count(*)::int as leftover from production_batch_fabric_usages where production_batch_id = ${draftBatch!.id}`) as unknown as [
        { leftover: number },
      ];
      expect(leftover).toBe(0);

      // ---- Re-running the migrator is a no-op. ----
      await migrate(drizzle(client), { migrationsFolder });
      const [{ triggerCount }] = (await client`
        select count(*)::int as "triggerCount" from pg_trigger
        where tgname in ('prevent_received_purchase_item_change', 'prevent_received_purchase_item_delete', 'prevent_posted_batch_fabric_usage_mutation')`) as unknown as [
        { triggerCount: number },
      ];
      expect(triggerCount).toBe(3);
      const [{ oldIndex }] = (await client`
        select count(*)::int as "oldIndex" from pg_indexes where indexname = 'purchase_items_purchase_id_fabric_id_key'`) as unknown as [
        { oldIndex: number },
      ];
      expect(oldIndex).toBe(0);
    } finally {
      await client.end();
      rmSync(upTo0045, { recursive: true, force: true });
    }
  });
});
