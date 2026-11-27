import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { migrationsFolder, migrationsUpTo } from "./scratch-database";

// Migration 0047 ("Berlaku untuk" on production batch cost lines): production_batch_costs.product_id
// and the production_batch_costs_scoped_quantity trigger. Upgrades a database at 0046 holding a
// draft and a posted batch with cost lines, then checks existing lines stay batch-wide and
// unchanged, the previous release's writes keep working, a scoped variable line's quantity is
// always its product's pcs (even when the previous release writes the batch total), a scoped line
// needs its product in the batch, posted lines stay frozen, and re-running is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_migration_0047_upgrade";

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

describe("migration 0047 (batch cost lines scoped to a product)", () => {
  test("upgrades a database at 0046, keeps existing lines batch-wide, and keeps scoped quantities right", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0046 = migrationsUpTo(46);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0046 });

      // ---- State at 0046, as the previous release leaves it. ----
      const [role] = await client`
        insert into roles (key, name, is_system) values ('super_admin', 'super_admin', true)
        on conflict (key) do update set name = excluded.name returning id`;
      const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
      const [tailor] = await client`insert into suppliers (name) values ('Konveksi Teh Popong') returning id`;
      const [fabric] = await client`insert into fabrics (name) values ('Marbella Anti UV') returning id`;
      const [sage] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Sage') returning id`;
      const insertProduct = (name: string, code: string) => client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values (${name}, ${code}, ${code.toLowerCase()}, ${fabric!.id}, 'front_zip', 'sized', 299000) returning id`;
      const [haura] = await insertProduct("Haura", "HAURA");
      const [cyra] = await insertProduct("Cyra", "CYRA");
      const [other] = await insertProduct("Nayla", "NAYLA");
      const insertVariant = (sku: string, productId: string) => client`
        insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
        values (${sku}, ${productId}, ${fabric!.id}, ${sage!.id}, 'front_zip', 'M')`;
      await insertVariant("HAURA-SAGE-M", haura!.id);
      await insertVariant("CYRA-SAGE-M", cyra!.id);
      await insertVariant("NAYLA-SAGE-M", other!.id);
      const [sewing] = await client`
        insert into cost_components (name, unit, cost_type) values ('Ongkos jahit', 'pcs', 'variable') returning id`;
      const [pattern] = await client`
        insert into cost_components (name, unit, cost_type) values ('Pola', 'pcs', 'fixed') returning id`;

      const [draft] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards)
        values (${fabric!.id}, 'B-202611-001', '2026-11-20', 30) returning id`;
      await client`
        insert into production_batch_items (production_batch_id, fabric_id, sku, qty) values
        (${draft!.id}, ${fabric!.id}, 'HAURA-SAGE-M', 10),
        (${draft!.id}, ${fabric!.id}, 'CYRA-SAGE-M', 8)`;
      const [oldLine] = await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, supplier_id, supplier_name)
        values (${draft!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 18, 38000, ${tailor!.id}, 'Konveksi Teh Popong') returning id`;

      const [posted] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards)
        values (${fabric!.id}, 'B-202611-002', '2026-11-21', 10) returning id`;
      await client`
        insert into production_batch_items (production_batch_id, fabric_id, sku, qty) values (${posted!.id}, ${fabric!.id}, 'HAURA-SAGE-M', 5)`;
      await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price)
        values (${posted!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 5, 39000)`;
      await client`update production_batches set status = 'posted', posted_at = now(), posted_by_staff_user_id = ${staff!.id} where id = ${posted!.id}`;

      const linesSql = () => client`
        select id, production_batch_id, quantity::text, unit_price::text, total::text, supplier_id from production_batch_costs order by id`;
      const linesBefore = await linesSql();

      await migrate(drizzle(client), { migrationsFolder });

      // ---- Existing lines: unchanged and batch-wide ("Semua produk"). ----
      expect(await linesSql()).toEqual(linesBefore);
      const [{ scoped }] = (await client`
        select count(*)::int as scoped from production_batch_costs where product_id is not null`) as unknown as [{ scoped: number }];
      expect(scoped).toBe(0);
      const [{ invalid }] = (await client`
        select count(*)::int as invalid from pg_constraint where not convalidated`) as unknown as [{ invalid: number }];
      expect(invalid).toBe(0);

      // ---- The previous release's writes keep working (it never names product_id). ----
      await client`update production_batch_costs set quantity = 18, unit_price = 39000 where id = ${oldLine!.id}`;
      const [newOld] = await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price)
        values (${draft!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 18, 1000) returning quantity::text`;
      expect(newOld!.quantity).toBe("18.00");

      // ---- A scoped variable line's quantity is its product's pcs, whatever is written. ----
      const [hauraLine] = await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, supplier_id, supplier_name, product_id)
        values (${draft!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 18, 39000, ${tailor!.id}, 'Konveksi Teh Popong', ${haura!.id})
        returning id, quantity::text, total::text`;
      expect(hauraLine).toMatchObject({ quantity: "10.00", total: "390000" });
      const [cyraLine] = await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, supplier_id, supplier_name, product_id)
        values (${draft!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 1, 37000, ${tailor!.id}, 'Konveksi Teh Popong', ${cyra!.id})
        returning id, quantity::text, total::text`;
      expect(cyraLine).toMatchObject({ quantity: "8.00", total: "296000" });
      // The previous release's save and its posting re-verify set every variable line to the
      // batch total; scoped lines are recomputed back to their product's pcs.
      await client`
        update production_batch_costs set quantity = 18
        where production_batch_id = ${draft!.id} and cost_type = 'variable'`;
      const afterOldUpdate = await client`
        select id, quantity::text, total::text from production_batch_costs where product_id is not null order by total desc`;
      expect(afterOldUpdate).toEqual([
        { id: hauraLine!.id, quantity: "10.00", total: "390000" },
        { id: cyraLine!.id, quantity: "8.00", total: "296000" },
      ]);
      // A fixed scoped line keeps quantity 1.
      const [fixedScoped] = await client`
        insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, product_id)
        values (${draft!.id}, ${pattern!.id}, 'Pola', 'pcs', 'fixed', 1, 80000, ${cyra!.id}) returning quantity::text`;
      expect(fixedScoped!.quantity).toBe("1.00");
      // Supplier bill sums every line of that supplier, scoped or not.
      const [{ bill }] = (await client`
        select sum(total)::text as bill from production_batch_costs
        where production_batch_id = ${draft!.id} and supplier_id = ${tailor!.id}`) as unknown as [{ bill: string }];
      expect(bill).toBe(String(18 * 39000 + 390000 + 296000));

      // ---- A scoped line needs its product in the batch. ----
      await expect(
        client`
          insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, product_id)
          values (${draft!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 1, 30000, ${other!.id})`,
      ).rejects.toThrow(/no SKU in this production batch/);
      await expect(client`update production_batch_costs set product_id = ${other!.id} where id = ${hauraLine!.id}`).rejects.toThrow(
        /no SKU in this production batch/,
      );
      // Moving a line back to "Semua produk" is plain (the trigger doesn't fire for NULL).
      await client`update production_batch_costs set product_id = null where id = ${cyraLine!.id}`;
      // A product referenced by a cost line can't be deleted.
      await client`delete from production_batch_items where production_batch_id = ${draft!.id} and sku = 'NAYLA-SAGE-M'`;
      await expect(client`delete from products where id = ${haura!.id}`).rejects.toThrow();

      // ---- Posted lines stay frozen (0007's trigger runs first). ----
      await expect(
        client`
          insert into production_batch_costs (production_batch_id, cost_component_id, component_name, component_unit, cost_type, quantity, unit_price, product_id)
          values (${posted!.id}, ${sewing!.id}, 'Ongkos jahit', 'pcs', 'variable', 5, 39000, ${haura!.id})`,
      ).rejects.toThrow(/posted production batch/);
      await expect(
        client`update production_batch_costs set product_id = ${haura!.id} where production_batch_id = ${posted!.id}`,
      ).rejects.toThrow(/posted production batch/);

      // Deleting the draft (the previous release's deleteDraft) cascades its lines.
      await client`delete from production_batches where id = ${draft!.id}`;

      // ---- Re-running the migrator is a no-op. ----
      await migrate(drizzle(client), { migrationsFolder });
      const [{ triggerCount }] = (await client`
        select count(*)::int as "triggerCount" from pg_trigger where tgname = 'production_batch_costs_scoped_quantity'`) as unknown as [
        { triggerCount: number },
      ];
      expect(triggerCount).toBe(1);
    } finally {
      await client.end();
      rmSync(upTo0046, { recursive: true, force: true });
    }
  });
});
