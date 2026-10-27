import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { auditLog, productionBatches, suppliers } from "@ammari/db/schema";
import { parseActivityLogFilters, type RawActivityLogFilters } from "./filters";
import { exportActivityLogRows, getActivityLogEntry, listActivityLog, recordActivityLogExport, resolveSearchTargets } from "./queries";

// Every row here is dated in 2001 and every filter targets 2001, so rows other test files commit
// to the shared ammari_test database never match (and withRollback discards these).

const DAY = "2001-03-04";

async function audit(tx: TestTx, values: Partial<typeof auditLog.$inferInsert> & { action: string; entityType: string }) {
  const [row] = await tx
    .insert(auditLog)
    .values({ entityId: randomUUID(), createdAt: new Date(`${DAY}T05:00:00Z`), ...values })
    .returning();
  return row!;
}

async function list(tx: TestTx, raw: RawActivityLogFilters, page?: string, perPage?: string) {
  return listActivityLog(parseActivityLogFilters({ from: DAY, to: DAY, ...raw }, DAY), page, perPage, tx);
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("listActivityLog filters", () => {
  test("the date range is inclusive Jakarta days (00:00 WIB = 17:00 UTC the day before)", async () => {
    await withRollback(async (tx) => {
      const lastMinute = await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date("2001-03-04T16:59:00Z") });
      const nextDay = await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date("2001-03-04T17:00:00Z") });
      const firstMinute = await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date("2001-03-03T17:00:00Z") });
      const dayBefore = await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date("2001-03-03T16:59:59Z") });

      const { rows, pagination } = await list(tx, {});
      expect(ids(rows)).toEqual([lastMinute.id, firstMinute.id]);
      expect(pagination.totalCount).toBe(2);
      expect(ids((await list(tx, { from: "2001-03-03", to: "2001-03-05" })).rows)).toEqual([nextDay.id, lastMinute.id, firstMinute.id, dayBefore.id]);
    });
  });

  test("by staff member, and by 'Sistem atau pembeli' (no staff actor)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const other = await insertStaffUser(tx);
      const mine = await audit(tx, { action: "update", entityType: "supplier", actorStaffUserId: staff.id });
      await audit(tx, { action: "update", entityType: "supplier", actorStaffUserId: other.id });
      const system = await audit(tx, { action: "track_shipment_poll", entityType: "order" });

      const byStaff = await list(tx, { actor: staff.id });
      expect(ids(byStaff.rows)).toEqual([mine.id]);
      expect(byStaff.rows[0]!.actor).toEqual({ kind: "staff", id: staff.id, name: staff.name, email: staff.email });

      const bySystem = await list(tx, { actor: "system" });
      expect(ids(bySystem.rows)).toEqual([system.id]);
      expect(bySystem.rows[0]!.actor).toEqual({ kind: "system", label: "Sistem" });
    });
  });

  test("by area, including actions moved to another area and unknown entity types under Lainnya", async () => {
    await withRollback(async (tx) => {
      const transition = await audit(tx, { action: "transition_status", entityType: "order" });
      const refund = await audit(tx, { action: "record_refund", entityType: "order" });
      const payment = await audit(tx, { action: "record", entityType: "supplier_payment" });
      const futureOrderAction = await audit(tx, { action: "teleport", entityType: "order" });
      const unknown = await audit(tx, { action: "launch", entityType: "spaceship" });

      expect(ids((await list(tx, { area: "orders" })).rows).sort()).toEqual([transition.id, futureOrderAction.id].sort());
      expect(ids((await list(tx, { area: "payments" })).rows).sort()).toEqual([refund.id, payment.id].sort());
      const other = await list(tx, { area: "other" });
      expect(ids(other.rows)).toEqual([unknown.id]);
      expect(other.rows[0]).toMatchObject({ actionLabel: "launch", areaLabel: "Lainnya", entity: { typeLabel: "spaceship", href: null } });
    });
  });

  test("entity search: order number finds the order and its card rows; exact id; staff email; supplier name", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { orderNo: `ORD-CARI-${randomUUID().slice(0, 6)}` });
      const card = await insertThankYouCard(tx, order.id);
      const otherOrder = await insertOrder(tx);
      const orderRow = await audit(tx, { action: "transition_status", entityType: "order", entityId: order.id });
      const cardRow = await audit(tx, { action: "claim", entityType: "thank_you_card", entityId: card.id });
      await audit(tx, { action: "transition_status", entityType: "order", entityId: otherOrder.id });

      const byOrderNo = await list(tx, { q: order.orderNo.slice(4).toLowerCase() });
      expect(ids(byOrderNo.rows).sort()).toEqual([orderRow.id, cardRow.id].sort());
      expect(ids((await list(tx, { q: order.channelOrderNo! })).rows).sort()).toEqual([orderRow.id, cardRow.id].sort());
      expect(ids((await list(tx, { q: order.id })).rows)).toEqual([orderRow.id]);

      const staff = await insertStaffUser(tx);
      const staffRow = await audit(tx, { action: "staff.deactivate", entityType: "staff_user", entityId: staff.id });
      expect(ids((await list(tx, { q: staff.email.toUpperCase() })).rows)).toEqual([staffRow.id]);

      const [supplier] = await tx.insert(suppliers).values({ name: `Toko Cari ${randomUUID().slice(0, 6)}` }).returning();
      const supplierRow = await audit(tx, { action: "update", entityType: "supplier", entityId: supplier!.id });
      expect(ids((await list(tx, { q: supplier!.name })).rows)).toEqual([supplierRow.id]);
    });
  });

  test("search: an uppercase uuid, batch accessory overrides by batch number, product_image reorder by product name", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const orderRow = await audit(tx, { action: "create", entityType: "order", entityId: order.id });
      expect(ids((await list(tx, { q: order.id.toUpperCase() })).rows)).toEqual([orderRow.id]);

      const { fabric, product } = await insertProductVariant(tx);
      const reorder = await audit(tx, { action: "reorder", entityType: "product_image", entityId: product.id });
      expect(ids((await list(tx, { q: product.name, area: "products" })).rows)).toContain(reorder.id);

      const batchNo = `PB-CARI-${randomUUID().slice(0, 6)}`;
      const [batch] = await tx.insert(productionBatches).values({ batchNo, fabricId: fabric.id, producedAt: DAY }).returning();
      const override = await audit(tx, { action: "set_override", entityType: "production_batch_accessory_override", entityId: `${batch!.id}:${randomUUID()}` });
      expect(ids((await list(tx, { q: batchNo })).rows)).toEqual([override.id]);
    });
  });

  test("a search matching more entities than the cap is flagged, never unbounded", async () => {
    await withRollback(async (tx) => {
      const prefix = `Toko Banyak ${randomUUID().slice(0, 6)}`;
      await tx.insert(suppliers).values([1, 2, 3].map((n) => ({ name: `${prefix} ${n}` })));
      const capped = await resolveSearchTargets(tx, prefix, 2);
      expect(capped.truncated).toBe(true);
      expect(capped.byType.get("supplier")).toHaveLength(2);
      expect((await resolveSearchTargets(tx, prefix, 3)).truncated).toBe(false);
      expect((await list(tx, { q: prefix })).searchTruncated).toBe(false);
    });
  });

  test("search treats % and _ literally", async () => {
    await withRollback(async (tx) => {
      await insertOrder(tx, { orderNo: `ORD-PCT-${randomUUID().slice(0, 6)}` }).then((order) => audit(tx, { action: "create", entityType: "order", entityId: order.id }));
      expect((await list(tx, { q: "%" })).rows).toEqual([]);
      expect((await list(tx, { q: "_" })).rows).toEqual([]);
    });
  });

  test("filters combine (AND): staff + area + search", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const order = await insertOrder(tx);
      const match = await audit(tx, { action: "record_refund", entityType: "order", entityId: order.id, actorStaffUserId: staff.id });
      await audit(tx, { action: "transition_status", entityType: "order", entityId: order.id, actorStaffUserId: staff.id });
      await audit(tx, { action: "record_refund", entityType: "order", entityId: order.id });
      await audit(tx, { action: "record_refund", entityType: "order", actorStaffUserId: staff.id });

      expect(ids((await list(tx, { actor: staff.id, area: "payments", q: order.orderNo })).rows)).toEqual([match.id]);
    });
  });

  test("newest first, paginated", async () => {
    await withRollback(async (tx) => {
      const created = [];
      for (let minute = 0; minute < 12; minute++) {
        created.push(await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date(`${DAY}T05:${String(minute).padStart(2, "0")}:00Z`) }));
      }
      const newestFirst = ids(created).reverse();
      const page1 = await list(tx, {}, "1", "10");
      const page2 = await list(tx, {}, "2", "10");
      expect(page1.pagination).toMatchObject({ page: 1, totalPages: 2, totalCount: 12 });
      expect(ids(page1.rows)).toEqual(newestFirst.slice(0, 10));
      expect(ids(page2.rows)).toEqual(newestFirst.slice(10));
    });
  });
});

describe("entity labels and actors", () => {
  test("labels and admin links resolved per type; buyer and system actors", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const card = await insertThankYouCard(tx, order.id);
      const { product, variant } = await insertProductVariant(tx);
      const orderRow = await audit(tx, { action: "transition_status", entityType: "order", entityId: order.id, createdAt: new Date(`${DAY}T05:04:00Z`) });
      const cardRow = await audit(tx, { action: "claim", entityType: "thank_you_card", entityId: card.id, createdAt: new Date(`${DAY}T05:03:00Z`) });
      const skuRow = await audit(tx, { action: "deactivate", entityType: "product_variant", entityId: variant.sku, createdAt: new Date(`${DAY}T05:02:00Z`) });
      const productRow = await audit(tx, { action: "update", entityType: "product", entityId: product.id, createdAt: new Date(`${DAY}T05:01:00Z`) });

      const byId = new Map((await list(tx, {})).rows.map((row) => [row.id, row]));
      expect(byId.get(orderRow.id)).toMatchObject({ actionLabel: "Status pesanan diubah", areaLabel: "Pesanan", actor: { kind: "system", label: "Sistem" }, entity: { typeLabel: "Pesanan", label: order.orderNo, href: `/orders/${order.id}` } });
      expect(byId.get(cardRow.id)).toMatchObject({ actor: { kind: "buyer", label: "Pembeli" }, entity: { label: `Kartu ${order.orderNo}`, href: `/orders/${order.id}` } });
      expect(byId.get(skuRow.id)!.entity).toEqual({ typeLabel: "Varian produk", label: variant.sku, href: `/products/${product.id}` });
      expect(byId.get(productRow.id)!.entity).toEqual({ typeLabel: "Produk", label: product.name, href: `/products/${product.id}` });
    });
  });

  test("a deleted entity falls back to its payload name, then to a short id; never crashes", async () => {
    await withRollback(async (tx) => {
      const gone = randomUUID();
      const named = await audit(tx, { action: "delete", entityType: "fabric", entityId: gone, before: { id: gone, name: "Katun Lama" } });
      const bare = await audit(tx, { action: "delete", entityType: "fabric", entityId: randomUUID() });
      const odd = await audit(tx, { action: "create", entityType: "order", entityId: "not-a-uuid" });
      // `code`/`key` are never used as a fallback label (could hold a secret-ish value).
      const coded = await audit(tx, { action: "delete", entityType: "fabric", entityId: randomUUID(), after: { code: "SECRET-ISH", key: "k" } });

      const byId = new Map((await list(tx, {})).rows.map((row) => [row.id, row]));
      expect(byId.get(named.id)!.entity).toEqual({ typeLabel: "Kain", label: "Katun Lama", href: null });
      expect(byId.get(bare.id)!.entity.label).toBe(bare.entityId.slice(0, 8));
      expect(byId.get(odd.id)!.entity).toEqual({ typeLabel: "Pesanan", label: "not-a-uuid", href: null });
      expect(byId.get(coded.id)!.entity.label).toBe(coded.entityId.slice(0, 8));
    });
  });

  test("getActivityLogEntry returns the payloads for the detail page; a bad or missing id is null", async () => {
    await withRollback(async (tx) => {
      const row = await audit(tx, { action: "update", entityType: "supplier", before: { name: "A" }, after: { name: "B" } });
      expect(await getActivityLogEntry(row.id, tx)).toMatchObject({ id: row.id, actionLabel: "Supplier diubah", before: { name: "A" }, after: { name: "B" } });
      expect(await getActivityLogEntry(randomUUID(), tx)).toBeNull();
      expect(await getActivityLogEntry("../etc", tx)).toBeNull();
    });
  });
});

describe("CSV export rows", () => {
  test("capped, with a truncation flag, newest first", async () => {
    await withRollback(async (tx) => {
      for (let minute = 0; minute < 4; minute++) await audit(tx, { action: "update", entityType: "supplier", createdAt: new Date(`${DAY}T05:0${minute}:00Z`) });
      const filters = parseActivityLogFilters({ from: DAY, to: DAY }, DAY);
      const capped = await exportActivityLogRows(filters, 3, tx);
      expect(capped.rows).toHaveLength(3);
      expect(capped.truncated).toBe(true);
      expect(capped.rows[0]!.createdAt.toISOString()).toBe(`${DAY}T05:03:00.000Z`);
      expect((await exportActivityLogRows(filters, 4, tx)).truncated).toBe(false);
    });
  });

  test("the export itself is audited with its filters and row count", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const filters = parseActivityLogFilters({ from: DAY, to: DAY, area: "orders" }, DAY);
      await recordActivityLogExport(staff.id, filters, 7, false, tx);
      const [row] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "audit_log"), eq(auditLog.actorStaffUserId, staff.id)));
      expect(row).toMatchObject({ action: "export", entityId: `${DAY}..${DAY}`, after: { filters: { from: DAY, to: DAY, area: "orders" }, rowCount: 7, truncated: false } });
    });
  });
});
